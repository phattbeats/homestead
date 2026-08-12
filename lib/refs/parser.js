// Homestead — Entity reference parser (PHA-1624 Phase D, PHA-1877).
//
// Detects `[[entity-name]]` cross-references in free-text fields (task
// titles/notes, event titles/notes, list items, activity feed bodies).
// The output feeds the resolver (`lib/refs/resolver.js`) which maps
// each parsed ref to a real entity or a stub.
//
// Public surface (per issue acceptance):
//   scanForReferences(text, containerKind, opts?) →
//     { refs: [{ name, position, length, raw }] }
//
//   parseReference(raw, containerKind, opts?) →
//     { name, position, length, raw } | null
//
// Design constraints (locked in this iteration):
//   * No external deps. Pure stdlib — cheap to test, deterministic.
//   * Idempotent re-scans: the parser is stateless. Same text → same
//     refs. Resolver owns the deduplication and side-effect idempotency.
//   * Reference syntax: `[[name]]` exactly. Whitespace inside the brackets
//     is allowed and collapsed; case is preserved (the resolver does the
//     case-insensitive match against entities).
//   * No false-positive matches in URL/path/code contexts — we don't try
//     to be HTML/Markdown aware here. The render layer owns that. If a
//     user writes `[Dune]` (single brackets), no ref is emitted.
//   * Escaped refs: `[[name with escaped \] bracket]]` is supported via
//     the `\]\]` escape. The resolver only sees the unescaped name.
//   * No anchor/heading refs (e.g. `[[name#section]]`) — Phase D's
//     scope is entity links only. Future-proof: the parser drops the
//     anchor and emits the entity name.
//
// Container kinds accepted:
//   'task'    — task title + notes
//   'event'   — event title + notes
//   'list_item' — list item text (forward-compat; no list feature yet)
//   'activity'  — activity feed body (forward-compat; no feed yet)
//
// The `containerKind` is informational for now — it lets the resolver
// emit correctly-typed `mentioned_in` edges (e.g. `mentioned_in_task`,
// `mentioned_in_event`) so the backlinks view on an entity page can
// group refs by container type. PHA-1624 §9.

'use strict';

const REF_OPEN = '[[';
const REF_CLOSE = ']]';

// Valid container kinds for validation. Forward-compatible — the parser
// doesn't fail on unknown kinds, it just passes them through.
const VALID_CONTAINER_KINDS = Object.freeze(new Set([
  'task', 'event', 'list_item', 'activity',
]));

// ---- Low-level scanner -------------------------------------------------

// Iterate over `[[name]]` patterns in `text`. Yields
// { name, position, length, raw } for each match. Skips:
//   * Single-bracket references (e.g. `[Dune]`, `[[Dune]`)
//   * Empty refs (`[[]]`, `[[ ]]`)
//   * Brackets inside code-fence-like backticks? No — that's the render
//     layer's job (the design doc §9 keeps refs simple).
//
// Position is the offset of the opening `[[` in the original text.
// `length` is the span from `[[` through `]]` (inclusive of brackets).
// `raw` is the unescaped content between the brackets, untouched
// aside from `\]` → `]`. `name` is `raw.trim()` collapsed to single
// spaces (refs in user prose usually have accidental spacing).
function* _scanRaw(text) {
  if (typeof text !== 'string' || !text) return;
  let i = 0;
  const n = text.length;
  while (i < n - 1) {
    if (text[i] === '[' && text[i + 1] === '[') {
      // Find the matching close. Allow escaped `]]` inside the name via `\]\]`.
      let j = i + 2;
      let closed = false;
      let nameBuf = '';
      while (j < n) {
        if (text[j] === '\\' && j + 1 < n && text[j + 1] === ']') {
          nameBuf += ']';
          j += 2;
          continue;
        }
        if (text[j] === ']' && text[j + 1] === ']') {
          closed = true;
          break;
        }
        nameBuf += text[j];
        j++;
      }
      if (closed) {
        const name = nameBuf.replace(/\s+/g, ' ').trim();
        const length = (j + 2) - i;
        if (name) {
          yield { name, position: i, length, raw: nameBuf };
        }
        i = j + 2;
        continue;
      }
      // Unterminated `[[` — skip the opener and continue. Common in
      // code/URLs; we don't want to swallow the rest of the doc.
      i += 2;
      continue;
    }
    i++;
  }
}

// ---- Public API --------------------------------------------------------

// Parse a single reference span (the substring between `[[` and `]]`,
// including any escapes). Returns the canonical shape or null if the
// input is not a usable ref. Useful for tests + the resolver when it
// wants to re-parse a raw fragment.
function parseReference(raw, containerKind, opts = {}) {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/\s+/g, ' ').trim();
  if (!name) return null;
  // Length cap: 200 chars. Anything longer is almost certainly a paste
  // accident, not a real entity name. Reject silently.
  if (name.length > 200) return null;
  // Reject names that contain control characters or newlines.
  if (/[\x00-\x1f\n\r]/.test(name)) return null;
  return {
    name,
    raw: opts.preserveRaw ? raw : name,
    position: typeof opts.position === 'number' ? opts.position : -1,
    length: typeof opts.length === 'number' ? opts.length : -1,
    containerKind: VALID_CONTAINER_KINDS.has(containerKind) ? containerKind : null,
  };
}

// Scan text for references. Returns `{ refs: [...] }`. Refs are emitted
// in document order. The resolver is responsible for dedup + entity
// resolution.
function scanForReferences(text, containerKind, opts = {}) {
  const refs = [];
  if (typeof text !== 'string' || !text) return { refs };
  for (const m of _scanRaw(text)) {
    const parsed = parseReference(m.raw, containerKind, {
      position: m.position,
      length: m.length,
      preserveRaw: opts.preserveRaw,
    });
    if (parsed) refs.push(parsed);
  }
  return { refs };
}

// Render rewrite helper. Given raw text and a list of { ref, entity }
// pairs (resolved refs with their target entity or stub), produce the
// HTML-ready string with `[[Name]]` replaced by `<a>` chips. Unresolved
// refs render as a chip with `data-ref-unresolved` so the UI can
// surface the "create or link" picker.
//
// `resolve(name)` should return:
//   null                                  → leave as plain text
//   { entityId, slug, name, resolved }    → resolved; `resolved=true`
//   { entityId, slug, name, resolved:false } → stub/queued
//
// This is a server-side string helper (no DOM). The browser uses the
// same algorithm in `public/index.html`'s `renderRefLinks()` — kept in
// sync via the parser unit tests.
function renderRefsInText(text, resolve, opts = {}) {
  if (typeof text !== 'string' || !text) return text || '';
  if (typeof resolve !== 'function') return text;
  const out = [];
  let cursor = 0;
  for (const m of _scanRaw(text)) {
    const parsed = parseReference(m.raw, opts.containerKind || 'task', {
      position: m.position,
      length: m.length,
      preserveRaw: true,
    });
    if (!parsed) continue;
    const target = resolve(parsed.name);
    if (cursor < m.position) out.push(escHtml(text.slice(cursor, m.position)));
    if (!target) {
      // No resolver opinion — leave the raw `[[...]]` text in place.
      out.push(escHtml(text.slice(m.position, m.position + m.length)));
    } else if (target.resolved) {
      out.push(`<a class="ref-chip" href="/entity/${escAttr(target.slug)}" data-ref-name="${escAttr(target.name)}">${escHtml(target.name)}</a>`);
    } else {
      out.push(`<a class="ref-chip unresolved" href="/review-queue?ref=${escAttr(encodeURIComponent(target.name))}" data-ref-name="${escAttr(target.name)}" data-ref-unresolved="1">${escHtml(target.name)}</a>`);
    }
    cursor = m.position + m.length;
  }
  if (cursor < text.length) out.push(escHtml(text.slice(cursor)));
  return out.join('');
}

// ---- HTML escape helpers (small + dependency-free) ----------------------

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
}

module.exports = {
  // public API
  scanForReferences,
  parseReference,
  renderRefsInText,
  // helpers (exported for tests + reuse)
  VALID_CONTAINER_KINDS,
  escHtml,
  escAttr,
};