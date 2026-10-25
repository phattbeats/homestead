'use strict';
//
// Reader for the Ledger's external edition (external-edition-v2).
//
// The Ledger's daily newspaper cron writes one dated artifact per day. This
// module reads it, checks it, and turns it into the external sections block
// that gets merged into a typed Gazette issue.
//
// Three rules shape everything here:
//
//   1. **Off by default.** With no directory configured, the reader returns
//      `disabled` and the caller merges nothing. Nothing about the existing
//      edition changes until someone opts in.
//
//   2. **Untrusted content.** Every title and summary in the artifact is
//      DATA. It is never passed to the harness as instruction and never
//      enters `buildPrompt` — external sections carry their own typed items
//      and are rendered as cards, not as prose for the model to work on.
//
//   3. **A bad artifact is a state, not a crash.** Missing, unreadable,
//      malformed, or stale files all resolve to a named status. A wire that
//      is down must never take the household edition down with it.
//
// The wire's own vocabulary is separate from the household's on purpose:
// `published` / `partial` / `stale` / `unavailable` mean something specific
// here and are not the same words the household edition uses.

const fs = require('fs');
const path = require('path');

// The external section registry, in print order. These keys are baked into
// stored issue rows, so they are one-way doors — renaming one is a migration
// over real history.
const EXTERNAL_SECTION_KEYS = Object.freeze([
  'world_news',
  'technology',
  'daily_podcast',
  'social_timeline',
  'social_forum',
]);

// Titles the wire uses. The artifact also carries a title per section; this
// table is the fallback when the artifact's is missing.
const EXTERNAL_TITLES = Object.freeze({
  world_news: 'The World Today',
  technology: 'Technology & Ideas',
  daily_podcast: 'Something to Listen To',
  social_timeline: 'From Your Timeline',
  social_forum: 'Around the Forum',
});

// Item types the renderer knows how to draw. Anything else is dropped rather
// than rendered raw.
const EXTERNAL_ITEM_TYPES = Object.freeze(['article', 'tweet', 'podcast']);

const MAX_TITLE_CHARS = 300;
const MAX_SUMMARY_CHARS = 500;

function externalConfig(env = process.env) {
  const dir = (env.GAZETTE_EXTERNAL_EDITION_DIR || '').trim();
  const ownerId = (env.GAZETTE_EXTERNAL_OWNER_ID || '').trim();
  return {
    dir,
    ownerId,
    // No directory configured means the feature is off. An owner is optional:
    // without one, personal sections are withheld from everyone.
    enabled: Boolean(dir),
  };
}

function emptyBlock(status, extra = {}) {
  return {
    status,
    edition_date: null,
    audience_scope: 'household',
    degraded_sources: [],
    stale_sections: [],
    sections: [],
    ...extra,
  };
}

function clamp(value, limit) {
  if (typeof value !== 'string') return '';
  if (value.length <= limit) return value;
  return value.slice(0, Math.max(0, limit - 1)).trimEnd() + '…';
}

function hoursSince(iso, now) {
  if (typeof iso !== 'string' || !iso) return Infinity;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Infinity;
  return (now.getTime() - t) / 3600000;
}

function readArtifact(dir, date) {
  // The file is named by edition date. A missing file for today's date means
  // "no wire today" — it never means yesterday's edition, which is the whole
  // point of keying on the date rather than on mtime.
  const file = path.join(dir, `${date}.json`);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, reason: err.code === 'ENOENT' ? 'no_artifact_for_date' : 'artifact_unreadable' };
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (_) {
    return { ok: false, reason: 'artifact_unparsable' };
  }
  if (!doc || typeof doc !== 'object') return { ok: false, reason: 'artifact_not_an_object' };
  if (doc.schema_version !== 2) return { ok: false, reason: 'unsupported_schema_version' };
  if (doc.type !== 'external.edition') return { ok: false, reason: 'unexpected_artifact_type' };
  if (doc.edition_date !== date) return { ok: false, reason: 'artifact_date_mismatch' };
  if (!Array.isArray(doc.sections)) return { ok: false, reason: 'artifact_missing_sections' };
  return { ok: true, doc };
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // The producer artifact names the type `kind`; the adapted consumer block
  // names it `type`. This reader consumes the artifact, so `kind` is the
  // field that carries it — `type` is accepted for a pre-adapted block.
  const rawType = typeof raw.type === 'string' ? raw.type : raw.kind;
  const type = EXTERNAL_ITEM_TYPES.includes(rawType) ? rawType : null;
  if (!type) return null;
  const title = clamp(typeof raw.title === 'string' ? raw.title : '', MAX_TITLE_CHARS);
  // A citation is required on every item. An uncited item is not renderable.
  const url = typeof raw.url === 'string' ? raw.url : '';
  if (!/^https?:\/\//.test(url)) return null;
  if (!title) return null;
  const item = {
    type,
    id: typeof raw.id === 'string' ? raw.id : '',
    title,
    summary: clamp(typeof raw.summary === 'string' ? raw.summary : '', MAX_SUMMARY_CHARS),
    url,
    source: typeof raw.source === 'string' ? raw.source : 'Source',
  };
  if (typeof raw.published_at === 'string' && raw.published_at) item.published_at = raw.published_at;
  if (typeof raw.author === 'string' && raw.author) item.author = clamp(raw.author, 80);
  if (type === 'podcast' && typeof raw.audio_url === 'string' && raw.audio_url.startsWith('https://')) {
    item.audio_url = raw.audio_url;
  }
  return item;
}

/**
 * readExternalEdition — produce the external sections block for one local day.
 *
 * @param {object} opts
 * @param {string} opts.date        Local date (YYYY-MM-DD) the issue is for.
 * @param {Date}   [opts.now]       Clock used for the age budget.
 * @param {string} [opts.userId]    Composing user, for the personal filter.
 * @param {object} [opts.env]       Environment to read the config from.
 */
function readExternalEdition({ date, now = new Date(), userId = null, env = process.env } = {}) {
  const config = externalConfig(env);
  if (!config.enabled) return emptyBlock('disabled');
  if (!date) return emptyBlock('unavailable', { reason: 'no_date' });

  const found = readArtifact(config.dir, date);
  if (!found.ok) return emptyBlock('unavailable', { reason: found.reason });

  const doc = found.doc;
  const ageHours = hoursSince(doc.generated_at, now);

  const degraded = (Array.isArray(doc.sources) ? doc.sources : [])
    .filter(s => s && s.status && s.status !== 'ok')
    .map(s => ({
      id: String(s.id || ''),
      label: String(s.label || s.id || ''),
      status: String(s.status || 'error'),
      error: typeof s.error === 'string' ? s.error.slice(0, 300) : null,
    }));

  const stale = [];
  const sections = [];
  let hasPersonal = false;

  for (const raw of doc.sections) {
    if (!raw || typeof raw !== 'object') continue;
    // The artifact names the consumer registry key in `homestead_key` (the
    // producer-side `id` is 'news', 'twitter', … and is NOT the registry key).
    // `key` is accepted as a fallback for a hand-made artifact.
    const candidate = EXTERNAL_SECTION_KEYS.includes(raw.homestead_key) ? raw.homestead_key : raw.key;
    const key = EXTERNAL_SECTION_KEYS.includes(candidate) ? candidate : null;
    // A section key this build does not know is dropped, not rendered raw.
    if (!key) continue;

    const maxAge = Number.isInteger(raw.max_age_hours) ? raw.max_age_hours : 48;
    if (ageHours >= maxAge) {
      stale.push(key);
      continue;
    }

    const audience = raw.audience === 'personal' ? 'personal' : 'household';
    if (audience === 'personal') {
      // Personal sections are the digest owner's picks, never the household's.
      // They are filtered here, in context assembly — never in the renderer.
      const isOwner = Boolean(config.ownerId) && String(userId || '') === config.ownerId;
      if (!isOwner) continue;
      hasPersonal = true;
    }

    const items = (Array.isArray(raw.items) ? raw.items : []).map(normalizeItem).filter(Boolean);
    if (!items.length) continue;

    sections.push({
      key,
      title: clamp(typeof raw.title === 'string' && raw.title ? raw.title : EXTERNAL_TITLES[key], 60),
      audience,
      source_label: clamp(typeof raw.source_label === 'string' ? raw.source_label : '', 120),
      headline: null,
      body: null,
      items,
    });
  }

  let status;
  if (!sections.length) {
    status = stale.length ? 'stale' : 'unavailable';
  } else if (degraded.length) {
    status = 'partial';
  } else {
    status = 'published';
  }

  return {
    status,
    edition_date: doc.edition_date,
    audience_scope: hasPersonal ? 'mixed' : 'household',
    degraded_sources: degraded,
    stale_sections: stale,
    sections,
    reason: !sections.length && !stale.length ? 'no_usable_sections' : null,
  };
}

module.exports = {
  EXTERNAL_SECTION_KEYS,
  EXTERNAL_TITLES,
  EXTERNAL_ITEM_TYPES,
  externalConfig,
  readExternalEdition,
};
