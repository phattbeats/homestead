// lib/gazette.js
//
// PHA-2659 — The Homestead Gazette. The morning edition.
//
// See docs/GAZETTE-DESIGN.md for the design note this implements. The
// short version:
//
//   * The edition is AGENT-AUTHORED, not templated. This file assembles
//     a context payload from what actually happened; the user's own
//     BYOK harness (the same one behind the agent drawer) writes the
//     prose. Nothing in here composes a sentence for the reader.
//   * One edition per user per local day, generated on FIRST OPEN and
//     cached. Never pushed, never cron-generated — opening the sheet is
//     what mints the day's edition.
//   * Thin-edition rule: quiet days print small and charming. Sections
//     whose context slice is empty are OMITTED, never padded. This file
//     enforces that on both sides — the prompt says which sections have
//     material, and `parseEdition` drops any section the harness
//     invented from an empty slice.
//
// Division of labour with lib/agent-runtime.js: that file owns the
// provider wire (`composeGazette` is its Gazette entry point, mirroring
// `draftPorchCandidate`). This file owns context, cache, prompt, and
// the edition schema. No LLM calls happen here.

'use strict';

const snapshot = require('./snapshot');
const healthChecker = require('./health-checker');
const weather = require('./weather');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

// `gazette_editions` — the per-user, per-day cache. `sections_json`
// holds the parsed edition (the structured shape below), NOT rendered
// HTML: the SPA renders it through esc() so harness output can never
// inject markup into the sheet.
//
// `status` distinguishes a real edition from the two degraded states
// worth remembering for the rest of the day:
//   * 'published'  — the harness wrote it.
//   * 'thin'       — published, but nothing happened; see THIN_NOTE.
//   * 'unavailable'— no key / provider error. Cached deliberately so a
//                    broken harness doesn't re-bill the user on every
//                    sheet open; `regenerate` clears it on demand.
function migrate(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS gazette_editions (
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  edition_date  TEXT    NOT NULL,
  tz            TEXT    NOT NULL DEFAULT 'UTC',
  status        TEXT    NOT NULL DEFAULT 'published'
                        CHECK (status IN ('published','thin','unavailable')),
  sections_json TEXT    NOT NULL DEFAULT '{}',
  error         TEXT,
  generated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, edition_date)
);
CREATE INDEX IF NOT EXISTS idx_gazette_editions_user ON gazette_editions(user_id, edition_date DESC);
`);

  // PHA-2853 rework — `gazette_issues` is the typed, back-issue-capable
  // successor the issue actually asked for: one row per user per day,
  // holding a TYPED (card-renderable) payload plus a typed weather
  // entry, queryable by date range for the standalone page's scrollback
  // and the 28-issue seed. `gazette_editions` above is left in place
  // untouched — it still backs the existing in-app sheet
  // (`GET /api/me/gazette/today`) so that surface's passing tests keep
  // testing real behavior. Both read the same `assembleContext()` /
  // `SECTIONS` material below, so there is one source of truth for
  // WHAT is newsworthy even though there are two stored shapes for now.
  db.exec(`
CREATE TABLE IF NOT EXISTS gazette_issues (
  date          TEXT    NOT NULL,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload_json  TEXT    NOT NULL DEFAULT '{}',
  weather_json  TEXT    NOT NULL DEFAULT '{}',
  generated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, date)
);
CREATE INDEX IF NOT EXISTS idx_gazette_issues_user_date ON gazette_issues(user_id, date DESC);
`);
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------
//
// The four sections from the approved mock (brand/…/shot-gazette.png):
// a Rotation Desk lede, two briefs (Arts & Media, Porch), and Today's
// Listings. `slice(ctx)` pulls the section's material out of the
// assembled context; a section with an empty slice is never offered to
// the harness and never rendered.
//
// Order here is the order the edition prints in.
const SECTIONS = Object.freeze([
  {
    key: 'rotation_desk',
    title: 'Rotation Desk',
    lede: true,
    hint: 'Whose turn it is, what is due, what slipped. This is the front-page lede — it gets the most words.',
    slice: ctx => ({
      due_today: ctx.today_tasks,
      overdue: ctx.overdue_tasks,
      due_this_week: ctx.upcoming_chores,
    }),
  },
  {
    key: 'arts_media',
    title: 'Arts & Media',
    lede: false,
    hint: 'What newly arrived in the library — films, shows, books, albums. Name the actual titles.',
    slice: ctx => ({ arrivals: ctx.arrivals }),
  },
  {
    key: 'porch',
    title: 'From the Porch',
    lede: false,
    hint: 'What people posted and said to each other overnight. Attribute by display name.',
    slice: ctx => ({ posts: ctx.porch_overnight.posts, comments: ctx.porch_overnight.comments }),
  },
  {
    key: 'listings',
    title: "Today's Listings",
    lede: false,
    hint: 'Today\'s calendar, in time order. Terse — this is a listings column, not prose. ' +
      'Each event may carry a `room` (a house location like Kitchen or Den, from PHA-2852) — ' +
      'when present, key the listing by it (e.g. "Kitchen: 6pm dinner"); when absent, list plain.',
    slice: ctx => ({ events: ctx.today_events }),
  },
]);

const SECTION_KEYS = Object.freeze(SECTIONS.map(s => s.key));

// A slice counts as "has material" when any array in it is non-empty.
function sliceHasMaterial(slice) {
  return Object.values(slice || {}).some(v => Array.isArray(v) && v.length > 0);
}

// Which sections have material today, in print order.
function availableSections(ctx) {
  return SECTIONS.filter(s => sliceHasMaterial(s.slice(ctx))).map(s => s.key);
}

// ---------------------------------------------------------------------------
// Context assembly
// ---------------------------------------------------------------------------

// Overnight Porch activity: posts and comments on walls this user is a
// member of, since `sinceIso`. "Overnight" is the window between the
// previous edition and now — see `overnightSince` below.
//
// Defensive about missing tables the same way lib/snapshot.js is: the
// Gazette must be buildable against a test DB that never ran
// walls.migrate().
function porchOvernight(db, userId, sinceIso, limit = 40) {
  const empty = { posts: [], comments: [], since: sinceIso };
  if (!hasTable(db, 'wall_posts') || !hasTable(db, 'wall_memberships')) return empty;
  try {
    const posts = db.prepare(`
      SELECT p.id, p.kind, p.text_body, p.link_title, p.created_at,
             w.slug AS wall_slug, w.name AS wall_name,
             u.display AS author_display
        FROM wall_posts p
        JOIN walls w             ON w.id = p.wall_id
        JOIN wall_memberships wm ON wm.wall_id = p.wall_id AND wm.user_id = ?
        JOIN users u             ON u.id = p.author_user_id
       WHERE p.created_at >= ?
       ORDER BY p.created_at DESC
       LIMIT ?
    `).all(userId, sinceIso, limit);

    const comments = hasTable(db, 'post_comments') ? db.prepare(`
      SELECT c.id, c.body, c.created_at,
             w.slug AS wall_slug,
             u.display AS author_display
        FROM post_comments c
        JOIN wall_posts p        ON p.id = c.post_id
        JOIN walls w             ON w.id = p.wall_id
        JOIN wall_memberships wm ON wm.wall_id = p.wall_id AND wm.user_id = ?
        JOIN users u             ON u.id = c.author_user_id
       WHERE c.created_at >= ?
       ORDER BY c.created_at DESC
       LIMIT ?
    `).all(userId, sinceIso, limit) : [];

    return { posts, comments, since: sinceIso };
  } catch (_) {
    return empty;
  }
}

// Entity arrivals: things that landed in the media/entity graph since
// `sinceIso`. This is the Arts & Media brief's input.
function entityArrivals(db, sinceIso, limit = 25) {
  if (!hasTable(db, 'entities')) return [];
  try {
    return db.prepare(`
      SELECT id, kind, name, slug, source_service, created_at
        FROM entities
       WHERE created_at >= ?
       ORDER BY created_at DESC
       LIMIT ?
    `).all(sinceIso, limit);
  } catch (_) {
    return [];
  }
}

// Tile health. The design note listed this as "not found in this repo
// at all — flag as a possible scope gap". It IS modelled, just under a
// different name: lib/health-checker.js keeps `service_health_state`
// per service and `listAll()` reads it. Only DEGRADED tiles are
// newsworthy — an all-green house has no health section, which is the
// thin-edition rule doing its job.
function tileHealth(db) {
  if (!hasTable(db, 'services')) return [];
  try {
    return healthChecker.listAll(db)
      .filter(s => s.status === 'down' || s.status === 'degraded')
      .map(s => ({
        name: s.name,
        status: s.status,
        down_since: s.down_since,
        last_error: s.last_error,
      }));
  } catch (_) {
    return [];
  }
}

function hasTable(db, name) {
  try {
    return !!db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(name);
  } catch (_) {
    return false;
  }
}

// The "overnight" window. Ideally it runs from the previous edition to
// now, so nothing that happened between two editions is ever silently
// skipped (open the Gazette on Monday and again on Thursday, and
// Thursday's edition still covers Tuesday and Wednesday). Falls back to
// 24h for a first-ever edition, and is clamped to 7 days so a long
// absence doesn't produce an unreadably fat edition.
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LOOKBACK_MS = 7 * DAY_MS;

function overnightSince(db, userId, nowMs) {
  let prior = null;
  if (hasTable(db, 'gazette_editions')) {
    const row = db.prepare(`
      SELECT generated_at FROM gazette_editions
       WHERE user_id = ? AND status <> 'unavailable'
       ORDER BY edition_date DESC LIMIT 1
    `).get(userId);
    if (row && row.generated_at) {
      const t = Date.parse(row.generated_at.replace(' ', 'T') + 'Z');
      if (Number.isFinite(t)) prior = t;
    }
  }
  const floor = nowMs - MAX_LOOKBACK_MS;
  const since = prior === null ? nowMs - DAY_MS : Math.max(prior, floor);
  return new Date(since).toISOString().replace('T', ' ').slice(0, 19);
}

// `assembleContext` — everything the harness gets to write from. Built
// on top of the PHA-1902 snapshot (`/api/me/snapshot`), which already
// carries tasks, events and lists in the §7 shape; the Gazette adds the
// three slices the snapshot doesn't have.
function assembleContext(db, username, { tz = 'UTC', now = new Date() } = {}) {
  const snap = snapshot.build(db, username, { tz, now });
  const since = overnightSince(db, snap.user.id, now.getTime());
  return {
    user: snap.user,
    date: snap.today,
    tz,
    generated_at: now.toISOString(),
    today_tasks: snap.today_tasks,
    overdue_tasks: snap.overdue_tasks,
    upcoming_chores: snap.upcoming.chores_due_next_7_days,
    today_events: snap.today_events,
    porch_overnight: porchOvernight(db, snap.user.id, since),
    arrivals: entityArrivals(db, since),
    tile_health: tileHealth(db),
  };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

// The voice rules handed to the harness. Per docs/VOICE.md Rule 2
// ("One voice, no shifts across modules") the Gazette does NOT get an
// editor persona of its own — a newspaper framing that drifted into
// broadsheet register would be exactly the cross-module voice shift
// that rule forbids. The masthead and section titles are structural and
// flat; only the lede and briefs are prose, and they follow the same
// warm/dry/slightly-amused register the rest of the app writes in.
const VOICE_RULES = [
  'Warm, dry, slightly amused. You are a friend who happens to be very good at running a house, not a broadsheet editor and not a press release.',
  'The reader is always the subject. "You have three things due" — never "the user has pending items".',
  'No exclamation marks unless something actually happened.',
  'Never congratulate the reader for existing, and never pad. If a section has little to say, say little.',
  'Every claim must come from the context below. Do not invent an event, a title, a name, or a number. If you cannot source it, leave it out.',
];

// The thin-edition line, used when literally nothing happened. Kept as
// a constant rather than a harness call: spending a token on "nothing
// happened" is the one case where the agent-authored rule earns
// nothing, and an empty house should still print something with a
// pulse. This is the only sentence in the Gazette that Homestead
// itself writes.
const THIN_NOTE = 'A quiet night. Nothing came in, nothing came due, and the house kept to itself.';

// `buildPrompt(ctx)` returns { system, user, sections } — `sections` is
// the list of section keys that actually have material, which the
// caller keeps so it can validate what comes back.
function buildPrompt(ctx) {
  const sections = availableSections(ctx);
  const printable = SECTIONS.filter(s => sections.includes(s.key));

  const system = [
    'You are writing one issue of The Homestead Gazette: a short morning edition for one household, about that household.',
    '',
    'VOICE:',
    ...VOICE_RULES.map(r => `- ${r}`),
    '',
    'FORMAT: reply with ONLY a JSON object, no prose around it, no code fence:',
    '{"lede":{"headline":string,"body":string},"briefs":[{"key":string,"headline":string,"body":string}],"editors_note":string}',
    '',
    'RULES:',
    `- Use ONLY these section keys, and only if you were given material for them: ${sections.join(', ') || '(none)'}.`,
    '- OMIT any section you have no material for. Do not include it with an empty or apologetic body. A short edition is correct on a quiet day; a padded one is not.',
    '- "lede" is the front page. Two or three sentences, not more.',
    '- Each brief is one to three sentences.',
    '- "editors_note" is one short line for the footer. It may be a question back to the reader.',
    '- Headlines are sentence case, no trailing period, under 60 characters.',
  ].join('\n');

  const material = printable.map(s => {
    return `### ${s.title} (key: ${s.key})\n${s.hint}\n${JSON.stringify(s.slice(ctx), null, 1)}`;
  }).join('\n\n');

  const user = [
    `Edition date: ${ctx.date} (${ctx.tz}). Reader: ${(ctx.user && ctx.user.display) || 'the household'}.`,
    ctx.tile_health.length
      ? `\nHouse systems currently unhappy (mention only if it matters to the reader today): ${JSON.stringify(ctx.tile_health)}`
      : '',
    '',
    material || '(No material at all today.)',
  ].join('\n');

  return { system, user, sections };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

// `parseEdition(text, allowedSections)` turns harness output into the
// stored shape, or throws. Deliberately strict about section keys: the
// thin-edition rule is only real if a harness that invents an "Arts &
// Media" brief on a day with zero arrivals gets that brief dropped.
//
// Tolerant about wrapping — harnesses commonly fence JSON or prefix it
// with a sentence — but never tolerant about content.
function parseEdition(text, allowedSections = SECTION_KEYS) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('empty_edition');

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const candidate = fenced ? fenced[1] : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);

  let obj;
  try {
    obj = JSON.parse(candidate);
  } catch (_) {
    throw new Error('unparseable_edition');
  }
  if (!obj || typeof obj !== 'object') throw new Error('unparseable_edition');

  const allowed = new Set(allowedSections);
  const titleFor = key => (SECTIONS.find(s => s.key === key) || {}).title || key;

  const lede = obj.lede && typeof obj.lede === 'object' ? {
    headline: str(obj.lede.headline),
    body: str(obj.lede.body),
  } : null;

  const briefs = (Array.isArray(obj.briefs) ? obj.briefs : [])
    .filter(b => b && allowed.has(b.key))
    .map(b => ({ key: b.key, title: titleFor(b.key), headline: str(b.headline), body: str(b.body) }))
    .filter(b => b.body)
    // Print in registry-declared section order, not whatever order the
    // harness happened to emit.
    .sort((a, b) => SECTION_KEYS.indexOf(a.key) - SECTION_KEYS.indexOf(b.key));

  if (!lede?.body && briefs.length === 0) throw new Error('empty_edition');

  return {
    lede: lede && lede.body ? lede : null,
    briefs,
    editors_note: str(obj.editors_note) || null,
  };
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

function getEdition(db, userId, date) {
  const row = db.prepare(
    'SELECT * FROM gazette_editions WHERE user_id = ? AND edition_date = ?'
  ).get(userId, date);
  if (!row) return null;
  let sections;
  try {
    sections = JSON.parse(row.sections_json);
  } catch (_) {
    return null; // corrupt cache row — regenerate rather than serve junk
  }
  return {
    date: row.edition_date,
    tz: row.tz,
    status: row.status,
    edition: sections,
    error: row.error || null,
    generated_at: row.generated_at,
    cached: true,
  };
}

function putEdition(db, userId, date, { tz, status, edition, error = null }) {
  db.prepare(`
    INSERT INTO gazette_editions (user_id, edition_date, tz, status, sections_json, error, generated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, edition_date) DO UPDATE SET
      tz = excluded.tz,
      status = excluded.status,
      sections_json = excluded.sections_json,
      error = excluded.error,
      generated_at = excluded.generated_at
  `).run(userId, date, tz || 'UTC', status, JSON.stringify(edition || {}), error);
  return getEdition(db, userId, date);
}

function clearEdition(db, userId, date) {
  db.prepare('DELETE FROM gazette_editions WHERE user_id = ? AND edition_date = ?').run(userId, date);
}

// ---------------------------------------------------------------------------
// Typed payload (PHA-2853)
// ---------------------------------------------------------------------------
//
// The issue wants CARD-renderable sections, not prose blocks: a typed
// `items[]` array per section, so `public/gazette.html` (and any future
// consumer) can render structured cards without depending on an LLM
// having run at all. Optional agent-authored `headline`/`body` prose can
// still be attached per section (buildPrompt/parseEdition above are
// reused unchanged for that) — but the section's typed items are always
// present and always safe to render on their own. This keeps the
// injection-safety rule intact: items are JSON fields (strings/numbers),
// rendered through esc() client-side, never raw HTML.

function typeTask(t, status) {
  return {
    type: 'task',
    id: t.id,
    title: t.title || t.text || '',
    assignee: t.assignee || null,
    due_date: t.due_date || null,
    status, // 'due_today' | 'overdue' | 'due_soon'
  };
}

function typeArrival(a) {
  return {
    type: 'arrival',
    id: a.id,
    kind: a.kind || null,
    name: a.name || '',
    slug: a.slug || null,
    source_service: a.source_service || null,
    created_at: a.created_at || null,
  };
}

function typePost(p) {
  return {
    type: 'post',
    id: p.id,
    wall_slug: p.wall_slug || null,
    wall_name: p.wall_name || null,
    author_display: p.author_display || null,
    kind: p.kind || null,
    text_body: p.text_body || null,
    link_title: p.link_title || null,
    created_at: p.created_at || null,
  };
}

function typeComment(c) {
  return {
    type: 'comment',
    id: c.id,
    wall_slug: c.wall_slug || null,
    author_display: c.author_display || null,
    body: c.body || null,
    created_at: c.created_at || null,
  };
}

function typeEvent(e) {
  return {
    type: 'event',
    id: e.id,
    title: e.title || '',
    time: e.time || null,
    notes: e.notes || null,
    // PHA-2852/PR#132 room-keyed listings: room_label is present when
    // the event carries a house_rooms room, absent otherwise — the
    // typed shape mirrors that instead of forcing a placeholder.
    room_id: e.room_id || null,
    room_label: e.room_label || null,
  };
}

// Section-key -> typed-items builder. Mirrors SECTIONS' `slice()` shape
// but returns typed, flat item lists instead of the raw slice object
// handed to the harness.
const TYPED_ITEMS = Object.freeze({
  rotation_desk: ctx => ([
    ...(ctx.today_tasks || []).map(t => typeTask(t, 'due_today')),
    ...(ctx.overdue_tasks || []).map(t => typeTask(t, 'overdue')),
    ...(ctx.upcoming_chores || []).map(t => typeTask(t, 'due_soon')),
  ]),
  arts_media: ctx => (ctx.arrivals || []).map(typeArrival),
  porch: ctx => ([
    ...(ctx.porch_overnight.posts || []).map(typePost),
    ...(ctx.porch_overnight.comments || []).map(typeComment),
  ]),
  listings: ctx => (ctx.today_events || []).map(typeEvent),
});

// `composeTypedPayload(ctx, { prose } = {})` — the typed issue payload.
// `prose` is an OPTIONAL parsed edition (the shape `parseEdition`
// returns: `{ lede, briefs, editors_note }`) whose per-section headline
///body gets attached to the matching typed section. Sections are
// omitted entirely when they have no material — the thin-edition rule
// applies here exactly as it does to the prose edition: quiet days
// print small, never padded with an empty card list.
function composeTypedPayload(ctx, { prose = null } = {}) {
  const availableKeys = availableSections(ctx);
  const briefByKey = new Map((prose && prose.briefs || []).map(b => [b.key, b]));

  const sections = SECTIONS
    .filter(s => availableKeys.includes(s.key))
    .map(s => {
      const items = (TYPED_ITEMS[s.key] || (() => []))(ctx);
      const brief = briefByKey.get(s.key);
      const isLede = s.lede && prose && prose.lede;
      const section = {
        key: s.key,
        title: s.title,
        items,
      };
      if (isLede) {
        section.headline = prose.lede.headline || null;
        section.body = prose.lede.body || null;
      } else if (brief) {
        section.headline = brief.headline || null;
        section.body = brief.body || null;
      }
      return section;
    });

  const thin = sections.length === 0;

  return {
    date: ctx.date,
    tz: ctx.tz,
    weather: weather.today(ctx.date),
    generated_at: new Date().toISOString(),
    thin,
    editors_note: (prose && prose.editors_note) || (thin ? THIN_NOTE : null),
    sections,
  };
}

// ---------------------------------------------------------------------------
// Issue store (PHA-2853) — `gazette_issues`, one row per user per day,
// queryable by range for back-issue browsing / seeding.
// ---------------------------------------------------------------------------

function getIssue(db, userId, date) {
  const row = db.prepare(
    'SELECT * FROM gazette_issues WHERE user_id = ? AND date = ?'
  ).get(userId, date);
  if (!row) return null;
  let payload, weatherEntry;
  try {
    payload = JSON.parse(row.payload_json);
    weatherEntry = JSON.parse(row.weather_json);
  } catch (_) {
    return null; // corrupt row — treat as a miss, caller regenerates
  }
  return {
    date: row.date,
    payload,
    weather: weatherEntry,
    generated_at: row.generated_at,
  };
}

function putIssue(db, userId, date, { payload, weatherEntry }) {
  db.prepare(`
    INSERT INTO gazette_issues (user_id, date, payload_json, weather_json, generated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, date) DO UPDATE SET
      payload_json = excluded.payload_json,
      weather_json = excluded.weather_json,
      generated_at = excluded.generated_at
  `).run(userId, date, JSON.stringify(payload || {}), JSON.stringify(weatherEntry || {}));
  return getIssue(db, userId, date);
}

// `listIssues(db, userId, { from, to, limit })` — back-issues in
// descending date order, for scrollback navigation and the seed script.
function listIssues(db, userId, { from = null, to = null, limit = 50 } = {}) {
  const clauses = ['user_id = ?'];
  const params = [userId];
  if (from) { clauses.push('date >= ?'); params.push(from); }
  if (to) { clauses.push('date <= ?'); params.push(to); }
  params.push(limit);
  const rows = db.prepare(`
    SELECT date, generated_at FROM gazette_issues
     WHERE ${clauses.join(' AND ')}
     ORDER BY date DESC LIMIT ?
  `).all(...params);
  return rows;
}

// `composeIssue(db, username, opts)` — the single entry point that
// assembles context and produces the typed payload for "today" (or
// `opts.now`'s local day). Does NOT touch the LLM — `prose` must be
// composed and parsed by the caller (server.js / jobs/gazette-daily.js)
// via `buildPrompt` + `agentRuntime.composeGazette` + `parseEdition`,
// exactly like the existing sheet route does, and handed in as
// `opts.prose`. Kept this way so a cron run that has no BYOK key
// configured can still produce a fully typed, card-renderable issue —
// the prose layer is additive, never required.
function composeIssue(db, username, { tz = 'UTC', now = new Date(), prose = null } = {}) {
  const ctx = assembleContext(db, username, { tz, now });
  const payload = composeTypedPayload(ctx, { prose });
  return { ctx, payload };
}

module.exports = {
  migrate,
  SECTIONS,
  SECTION_KEYS,
  THIN_NOTE,
  VOICE_RULES,
  assembleContext,
  availableSections,
  buildPrompt,
  parseEdition,
  getEdition,
  putEdition,
  clearEdition,
  // PHA-2853 typed payload + issue store
  composeTypedPayload,
  composeIssue,
  getIssue,
  putIssue,
  listIssues,
  // exported for unit tests
  porchOvernight,
  entityArrivals,
  tileHealth,
  overnightSince,
};
