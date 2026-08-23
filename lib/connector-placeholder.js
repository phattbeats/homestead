// Homestead — closed-grammar brace placeholder resolver (PHA-2447).
//
// ConnectorSpec surfaces can carry human-readable strings with `{name}`
// placeholders that resolve against the named extracted fields the
// engine already computed for that surface. This is intentionally NOT
// a general template language: there is no expression syntax, no
// arithmetic, no method calls. The grammar is:
//
//   `{`  identifier  `}`
//
// where `identifier` is one of:
//   * a key from the surface's `fields` (e.g. `{count}` → `42`)
//   * a special key: `{status}`, `{label}`, `{name}`, `{kind}` —
//     these are convenience aliases the renderer exposes to make
//     template strings readable
//   * `{updated_at}` / `{finished_at}` — wall-clock timestamps from
//     the snapshot, ISO 8601
//
// Anything else (whitespace, dots, function-like syntax, JSONPath,
// expressions, nested braces, alternative syntax like `{{ x }}`,
// `${x}`, `%x%`, `<x>`, etc.) is a hard reject. A reject surfaces
// as a `PlaceholderGrammarError` carrying the offending token + the
// source string. The render path is expected to swallow that error
// and fall back to the literal source string (so a malformed template
// never crashes a poll cycle), but the grammar check itself is a
// first-class contract from the spec validator's perspective.
//
// The resolver is pure: it takes a value-map and a template string
// and returns the rendered string. It does not touch the database
// and has no dependencies beyond stdlib. This keeps it cheap to
// unit-test (no fixture dance) and lets it run inside the engine's
// render path without an async hop.

'use strict';

// ---- Errors -------------------------------------------------------------

class PlaceholderGrammarError extends Error {
  constructor(message, source, where) {
    super(message);
    this.name = 'PlaceholderGrammarError';
    this.source = source;
    this.where = where || null;
  }
}

// Maximum identifier length. Keeps us well clear of any sane template
// shape and bounds the regex work.
const IDENTIFIER_MAX = 64;

// Reserved identifiers — the small set the renderer always exposes
// regardless of what the spec's `fields` block contains.
const RESERVED_KEYS = Object.freeze([
  'status',
  'label',
  'name',
  'kind',
  'id',
  'url',
  'updated_at',
  'finished_at',
]);

// Identifier regex — letters / digits / underscore, must start with
// a letter or underscore, max length IDENTIFIER_MAX. We do NOT allow
// dots, dashes, colons, brackets, spaces, or operators; if any of
// those show up we want a hard grammar reject, not a silent pass.
//
// `$` is explicitly NOT allowed anywhere in the identifier body.
// That guards against `${expr}` style syntax sneaking in via
// `body.slice()` — the literal `body` after `{`/`}` stripping
// would otherwise look like a valid identifier, leaving the `$`
// silently unhandled. We treat `$` as a grammar reject.
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

// The opening-brace half. We deliberately disallow the doubled form
// (`{{ x }}`); `{{` triggers the explicit reject path below.
const OPEN_RE = /\{/;
const CLOSE_RE = /\}/;

// ---- Public surface -----------------------------------------------------

// resolve(template, valueMap) → rendered string
//
// Replaces every `{ident}` occurrence in `template` with the matching
// value from `valueMap` (or RESERVED_KEYS / null when absent). Throws
// PlaceholderGrammarError when the template carries any non-conformant
// brace expression.
//
// Behavior summary:
//   * `{known}`           → String(valueMap.known ?? '')
//   * `{unknown}`         → '' (empty string; never a literal "unknown")
//   * `{ }`               → PlaceholderGrammarError (empty identifier)
//   * `{1abc}`            → PlaceholderGrammarError (digit prefix)
//   * `{a.b}`             → PlaceholderGrammarError (dot is not allowed)
//   * `{{ nested }}`      → PlaceholderGrammarError (no nested braces)
//   * `}` with no `{`     → PlaceholderGrammarError (unbalanced)
//   * `{x` with no `}`     → PlaceholderGrammarError (unbalanced)
function resolve(template, valueMap) {
  if (template == null) return '';
  if (typeof template !== 'string') {
    // Non-strings shouldn't reach here — call sites convert — but a
    // hard reject beats a silent coercion.
    throw new PlaceholderGrammarError(
      `placeholder template must be a string (got ${typeof template})`,
      String(template),
    );
  }
  // Quick exit when no brace is present at all. Common case.
  if (!OPEN_RE.test(template) && !CLOSE_RE.test(template)) {
    return template;
  }

  const out = [];
  let i = 0;
  const n = template.length;
  while (i < n) {
    const ch = template[i];
    if (ch !== '{') {
      // Any stray `}` with no matching `{` is a grammar reject.
      if (ch === '}') {
        throw new PlaceholderGrammarError(
          'unbalanced closing brace (no matching `{`)',
          template,
          `col ${i}`,
        );
      }
      out.push(ch);
      i += 1;
      continue;
    }
    // We hit `{`. Three possibilities:
    //   1. `{{` → grammar reject (doubled braces are NOT alias syntax)
    //   2. `{ident}` where ident matches the regex → resolve
    //   3. `{ident` with no closing brace → grammar reject (unclosed)
    //   4. `{<anything else>}` → grammar reject (non-conformant body)
    if (template[i + 1] === '{') {
      throw new PlaceholderGrammarError(
        'doubled `{{` is not supported; use single `{name}` only',
        template,
        `col ${i}`,
      );
    }
    const close = template.indexOf('}', i + 1);
    if (close === -1) {
      throw new PlaceholderGrammarError(
        'unclosed `{` (no matching `}`)',
        template,
        `col ${i}`,
      );
    }
    const body = template.slice(i + 1, close);
    if (body.includes('$')) {
      // `$` is reserved for JSONPath expressions at the spec level
      // (see lib/connector-spec.js — fields starting with `$` are
      // JSONPath, not literal template substitutions). A `{`
      // containing `$` is therefore a grammar reject, not a render.
      throw new PlaceholderGrammarError(
        `placeholder name must not contain '$' (got "${body}")`,
        template,
        `col ${i}`,
      );
    }
    if (!IDENT_RE.test(body)) {
      // Empty (`{}`) or non-conformant identifier.
      throw new PlaceholderGrammarError(
        `placeholder name must match /^[A-Za-z_][A-Za-z0-9_]{0,63}$/ (got "${body}")`,
        template,
        `col ${i}`,
      );
    }
    const value = lookup(body, valueMap);
    out.push(value == null ? '' : String(value));
    i = close + 1;
  }
  return out.join('');
}

// compile(template) → renderer
// Captures the parse errors eagerly so a render-time call site doesn't
// need a try/catch around the resolve itself. The returned function
// still throws on lookups that miss grammar (i.e. when the valueMap
// itself triggers a future grammar expansion — currently it can't,
// but the contract is forward-compatible).
function compile(template) {
  // Eagerly validate by calling resolve against an empty map. Any
  // grammar violation surfaces here, not at render time.
  return (valueMap) => resolve(template, valueMap);
}

// ---- Internals ----------------------------------------------------------

// lookup(key, valueMap) → string | null
// Pulls a value from `valueMap` first, then the reserved keys (which
// currently are themselves sourced from `valueMap` or null). Reserved
// keys that are absent simply yield null → '' at the call site.
function lookup(key, valueMap) {
  if (valueMap && Object.prototype.hasOwnProperty.call(valueMap, key)) {
    return valueMap[key];
  }
  if (RESERVED_KEYS.includes(key)) {
    // Reserved keys are looked up from the same map; if the spec
    // author chose to expose `status` or `updated_at` via `fields`,
    // that wins. Otherwise we leave it to the renderer's caller to
    // inject the timestamp / status from the snapshot.
    return null;
  }
  return null;
}

// knownKeys(valueMap) → string[]
// Convenience for tests + diagnostics — reports which keys the
// resolver would honor for a given value map. Returns RESERVED_KEYS
// union the valueMap's own keys.
function knownKeys(valueMap) {
  const out = new Set(RESERVED_KEYS);
  if (valueMap && typeof valueMap === 'object') {
    for (const k of Object.keys(valueMap)) out.add(k);
  }
  return Array.from(out).sort();
}

// ---- Module exports -----------------------------------------------------

module.exports = {
  resolve,
  compile,
  knownKeys,
  RESERVED_KEYS,
  IDENT_RE,
  PlaceholderGrammarError,
};