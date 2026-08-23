// Homestead — RFC 9535 JSONPath parser (subset).
//
// PHA-2444 (Connector Forge): declarative connector specs cannot express
// arbitrary computation. They reference fields in upstream JSON via
// JSONPath, so the parser MUST be a real, auditable, grammar-driven
// parser — never `eval`, never regex-on-source. Specs that try to use
// features outside the supported subset are rejected at install time.
//
// Supported subset (deliberately tiny — every feature here is justified
// by a concrete need in the surface mapping cases below):
//
//   $                 — root
//   $.name            — child-name selector
//   $['name']         — bracketed-name selector (quoted, escapes allowed)
//   $.a.b.c           — chain of name selectors
//   $.items[0]        — index selector (non-negative integer only)
//   $.items[-1]       — NOT supported (count-from-end is in RFC 9535 but
//                        the connector mapping cases don't need it; we
//                        reject it loudly so a future index-of-last bug
//                        can't quietly slip in)
//   $.items[0].name
//   $.items[*]        — wildcard index selector
//   $.items[0:10]     — slice selector [start, end)
//                       start and end are both optional
//                       step defaults to 1; explicit step is NOT supported
//                       (we don't have a use case and it doubles the
//                       parser surface)
//   $.items[*].name   — wildcard then name
//
// Explicitly OUT (rejected with a precise error so a future authoring
// bug surfaces as "we don't support that", not as silent truncation):
//
//   @                  — current node (no use in declarative mapping)
//   ..                 — descendant segment (unbounded traversal — bans
//                        any upper bound on work per request)
//   ?(...)             — filter (predicate evaluation requires scripting)
//   (..)               — descendant name
//   [?(@.x>1)]         — filter expressions
//   [start:end:step]   — slices with explicit step (any-step can deny
//                        service via pathologically-large work)
//   [*]                — wildcard at root ($[*] alone is nonsense — root
//                        is always an object/array, never "all of them")
//   $..items           — descendant name
//
// The parser returns a flat list of segments so the evaluator can walk
// it cheaply. No recursion in the hot path beyond what Array.prototype
// already does.
//
// This module is pure (no I/O, no globals beyond what's loaded). The
// evaluator is intentionally small and side-effect-free; the
// connector engine (PHA-2445) layers caching + per-probe scheduling
// on top.

'use strict';

// ---- Tokens -------------------------------------------------------------

// We hand-roll a lexer because the grammar is tiny and a third-party
// tokenizer would pull in things the engine doesn't need. Each token
// is { kind, value, pos } where `pos` is the byte offset in the input
// — useful for error messages.

const T = Object.freeze({
  ROOT:    'ROOT',     // $
  NAME:    'NAME',     // identifier (a-z A-Z 0-9 _ -)
  LBRACK:  'LBRACK',   // [
  RBRACK:  'RBRACK',   // ]
  LPAR:    'LPAR',     // (
  RPAR:    'RPAR',     // )
  DOT:     'DOT',      // .
  STAR:    'STAR',     // *
  COLON:   'COLON',    // :
  QUESTION:'QUESTION', // ?
  ELLIPSIS:'ELLIPSIS', // ..
  BRACK_NAME:'BRACK_NAME', // contents of ['...'] or ["..."]
  INT:     'INT',      // non-negative integer
  EOF:     'EOF',
});

function isNameStart(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}
function isNameCont(c) {
  return isNameStart(c) || (c >= '0' && c <= '9') || c === '-';
}
function isDigit(c) {
  return c >= '0' && c <= '9';
}

function tokenize(input) {
  const tokens = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    const c = input[i];

    // Skip whitespace? RFC 9535 doesn't define whitespace between
    // segments; we allow it because humans paste expressions with
    // spaces and rejecting on whitespace would be hostile. We DO
    // NOT skip whitespace inside bracketed names or numbers.
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }

    if (c === '$' && i === 0) {
      tokens.push({ kind: T.ROOT, value: '$', pos: i });
      i++;
      continue;
    }

    if (c === '.') {
      if (input[i + 1] === '.') {
        tokens.push({ kind: T.ELLIPSIS, value: '..', pos: i });
        i += 2;
        continue;
      }
      tokens.push({ kind: T.DOT, value: '.', pos: i });
      i++;
      continue;
    }

    if (c === '[') {
      tokens.push({ kind: T.LBRACK, value: '[', pos: i });
      i++;
      continue;
    }
    if (c === ']') {
      tokens.push({ kind: T.RBRACK, value: ']', pos: i });
      i++;
      continue;
    }
    if (c === '(') {
      tokens.push({ kind: T.LPAR, value: '(', pos: i });
      i++;
      continue;
    }
    if (c === ')') {
      tokens.push({ kind: T.RPAR, value: ')', pos: i });
      i++;
      continue;
    }
    if (c === '*') {
      tokens.push({ kind: T.STAR, value: '*', pos: i });
      i++;
      continue;
    }
    if (c === ':') {
      tokens.push({ kind: T.COLON, value: ':', pos: i });
      i++;
      continue;
    }
    if (c === '?') {
      tokens.push({ kind: T.QUESTION, value: '?', pos: i });
      i++;
      continue;
    }
    // Filter expression syntax — the only valid filter form is
    // [?(...)], which the parser doesn't support. Detect it inline
    // so the error message is precise rather than the unhelpful
    // "unexpected character @".
    if (c === '@') {
      throw new ParseError('filter expressions "[?(...)]" are not supported (current node "@" is a filter-only token)', i);
    }
    if (c === ',') {
      // Commas are illegal in our subset. The parser would catch this
      // later as "unexpected character ,", but emitting a precise
      // error here helps when the comma is inside a bracket pair that
      // looks like a filter (e.g. "[a,b]").
      throw new ParseError('union expressions "[a,b]" are not supported (commas separate items in our subset)', i);
    }

    if (c === "'" || c === '"') {
      const quote = c;
      const startPos = i;
      i++;
      let buf = '';
      while (i < n && input[i] !== quote) {
        if (input[i] === '\\' && i + 1 < n) {
          const next = input[i + 1];
          // Only JSON-string escapes are honored (RFC 9535 §2.3.1).
          if (next === '"' || next === "'" || next === '\\' || next === '/' ||
              next === 'b' || next === 'f' || next === 'n' || next === 'r' || next === 't') {
            buf += next === 'b' ? '\b' :
                   next === 'f' ? '\f' :
                   next === 'n' ? '\n' :
                   next === 'r' ? '\r' :
                   next === 't' ? '\t' : next;
            i += 2;
          } else if (next === 'u' && i + 5 < n) {
            // \uXXXX — strict 4 hex digits.
            const hex = input.slice(i + 2, i + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              throw new ParseError(`bad \\u escape at position ${i}`, i);
            }
            buf += String.fromCharCode(parseInt(hex, 16));
            i += 6;
          } else {
            throw new ParseError(`bad escape "\\${next}" at position ${i}`, i);
          }
          continue;
        }
        buf += input[i];
        i++;
      }
      if (i >= n) {
        throw new ParseError(`unterminated string literal at position ${startPos}`, startPos);
      }
      // Skip closing quote.
      i++;
      tokens.push({ kind: T.BRACK_NAME, value: buf, pos: startPos });
      continue;
    }

    if (isDigit(c)) {
      const start = i;
      while (i < n && isDigit(input[i])) i++;
      // Reject leading zeros on multi-digit numbers? RFC 9535 says yes
      // for the integer literal form. We follow suit because a stray
      // `007` is almost certainly a typo for `7`.
      const raw = input.slice(start, i);
      if (raw.length > 1 && raw[0] === '0') {
        throw new ParseError(`leading zero not allowed in integer at position ${start}`, start);
      }
      tokens.push({ kind: T.INT, value: parseInt(raw, 10), pos: start });
      continue;
    }

    if (isNameStart(c)) {
      const start = i;
      while (i < n && isNameCont(input[i])) i++;
      tokens.push({ kind: T.NAME, value: input.slice(start, i), pos: start });
      continue;
    }

    throw new ParseError(`unexpected character "${c}" at position ${i}`, i);
  }

  tokens.push({ kind: T.EOF, value: null, pos: n });
  return tokens;
}

// ---- Errors -------------------------------------------------------------

class ParseError extends Error {
  constructor(message, pos) {
    super(`JSONPath parse error at position ${pos}: ${message}`);
    this.name = 'JSONPathParseError';
    this.position = pos;
  }
}

// ---- Parser -------------------------------------------------------------
//
// Grammar (subset):
//   path        := root segment*
//   root        := '$'
//   segment     := '.' NAME
//                | '[' bracketed ']'
//   bracketed   := '*'                              (wildcard)
//                | INT                              (index)
//                | INT? ':' INT?                    (slice, step=1)
//                | STRING                           (bracketed-name)

function parse(input) {
  if (typeof input !== 'string') {
    throw new ParseError('path must be a string', 0);
  }
  if (input.length === 0) {
    throw new ParseError('empty path', 0);
  }
  const tokens = tokenize(input);
  let pos = 0;

  function peek(k = 0) { return tokens[pos + k]; }
  function consume(kind, value) {
    const t = tokens[pos];
    if (!t || t.kind !== kind || (value !== undefined && t.value !== value)) {
      throw new ParseError(
        `expected ${kind}${value !== undefined ? `("${value}")` : ''} but got ${t ? `${t.kind}("${t.value}")` : 'end of input'}`,
        t ? t.pos : input.length
      );
    }
    pos++;
    return t;
  }

  // Root must come first.
  const root = consume(T.ROOT);
  if (root.pos !== 0) {
    throw new ParseError('"$" must be at the start of the path', root.pos);
  }

  const segments = [];
  while (peek().kind !== T.EOF) {
    const tk = peek();
    if (tk.kind === T.DOT) {
      consume(T.DOT);
      const nameTk = peek();
      if (nameTk.kind === T.NAME) {
        segments.push({ type: 'name', value: nameTk.value });
        pos++;
      } else if (nameTk.kind === T.STAR) {
        throw new ParseError('wildcard ".*" is not supported — use "[*]" inside an array', nameTk.pos);
      } else {
        throw new ParseError(`expected name or "*" after "." at position ${nameTk.pos}`, nameTk.pos);
      }
      continue;
    }
    if (tk.kind === T.LBRACK) {
      consume(T.LBRACK);
      const inner = peek();
      if (inner.kind === T.STAR) {
        consume(T.STAR);
        consume(T.RBRACK);
        // Reject "$[*]" alone (wildcard as the only/last segment) —
        // root is always one value, "all of them" doesn't match
        // anything. We DO allow "$[*].name" — wildcard then descend
        // — because that's the legitimate array-iteration case.
        if (segments.length === 0 && peek().kind === T.EOF) {
          throw new ParseError('wildcard "$[*]" at root is not supported', inner.pos);
        }
        segments.push({ type: 'wildcard' });
        continue;
      }
      if (inner.kind === T.INT) {
        consume(T.INT);
        if (peek().kind === T.COLON) {
          // slice form
          consume(T.COLON);
          let end = null;
          if (peek().kind === T.INT) {
            end = consume(T.INT).value;
          }
          if (peek().kind === T.COLON) {
            throw new ParseError('slices with explicit step are not supported', peek().pos);
          }
          consume(T.RBRACK);
          segments.push({ type: 'slice', start: inner.value, end });
          continue;
        }
        consume(T.RBRACK);
        segments.push({ type: 'index', value: inner.value });
        continue;
      }
      // Detect filter expressions early so we get a clean error rather
      // than "unexpected character @". The lexer doesn't tokenize '@'
      // — it falls through to "unexpected character".
      if (input.indexOf('@', tk.pos + 1) !== -1 && input.indexOf('@', tk.pos + 1) < input.indexOf(']', tk.pos + 1)) {
        throw new ParseError('filter expressions "[?(...)]" are not supported', tk.pos);
      }
      if (input.indexOf(',', tk.pos + 1) !== -1 && input.indexOf(',', tk.pos + 1) < input.indexOf(']', tk.pos + 1)) {
        throw new ParseError('union expressions "[a,b]" are not supported', tk.pos);
      }
      if (inner.kind === T.COLON) {
        // [:end]
        consume(T.COLON);
        let end = null;
        if (peek().kind === T.INT) {
          end = consume(T.INT).value;
        }
        if (peek().kind === T.COLON) {
          throw new ParseError('slices with explicit step are not supported', peek().pos);
        }
        consume(T.RBRACK);
        segments.push({ type: 'slice', start: 0, end });
        continue;
      }
      if (inner.kind === T.BRACK_NAME) {
        consume(T.BRACK_NAME);
        consume(T.RBRACK);
        segments.push({ type: 'name', value: inner.value });
        continue;
      }
      throw new ParseError(`unexpected token ${inner.kind} inside brackets at position ${inner.pos}`, inner.pos);
    }
    if (tk.kind === T.ELLIPSIS) {
      throw new ParseError('descendant ".." operator is not supported', tk.pos);
    }
    if (tk.kind === T.QUESTION) {
      throw new ParseError('filter expressions "[?(...)]" are not supported', tk.pos);
    }
    if (tk.kind === T.LPAR) {
      throw new ParseError('script expressions "(...)" are not supported', tk.pos);
    }
    throw new ParseError(`unexpected token ${tk.kind}("${tk.value}") at position ${tk.pos}`, tk.pos);
  }

  return segments;
}

// ---- Evaluator ----------------------------------------------------------
//
// `evaluate(segments, value)` returns the matched value or undefined.
// Single-match semantics (not multi-match) because every connector
// mapping in v1 wants one specific value, not a list of matches.
// Wildcards ARE allowed because some mappings (e.g. "pick the first
// item from a list of series") want a child-name segment after `[*]`.

function evaluate(segments, value) {
  let current = value;
  for (const seg of segments) {
    if (current === undefined || current === null) return undefined;
    if (seg.type === 'name') {
      if (typeof current !== 'object' || Array.isArray(current)) return undefined;
      current = current[seg.value];
      continue;
    }
    if (seg.type === 'index') {
      if (!Array.isArray(current)) return undefined;
      if (seg.value < 0 || seg.value >= current.length) return undefined;
      current = current[seg.value];
      continue;
    }
    if (seg.type === 'wildcard') {
      if (!Array.isArray(current)) return undefined;
      // Caller decides what to do with the array; in mapping context
      // they iterate. Here we return undefined so the caller can
      // distinguish "matched nothing" from "matched an array" — the
      // engine wraps this with `pickFirst/All` helpers anyway.
      return undefined;
    }
    if (seg.type === 'slice') {
      if (!Array.isArray(current)) return undefined;
      const start = seg.start === null ? 0 : Math.max(0, seg.start);
      const end = seg.end === null ? current.length : Math.min(current.length, seg.end);
      if (end <= start) return undefined;
      current = current.slice(start, end);
      continue;
    }
    return undefined;
  }
  return current;
}

// Wildcard-aware evaluation: returns an array of matches for paths
// that contain a wildcard segment. Used by connector mappings that
// iterate (e.g. `$.series[*].name` to get every series name).

function evaluateAll(segments, value) {
  let paths = [[value]];
  for (const seg of segments) {
    const next = [];
    for (const p of paths) {
      const current = p[p.length - 1];
      if (current === undefined || current === null) continue;
      if (seg.type === 'name') {
        if (typeof current !== 'object' || Array.isArray(current)) continue;
        next.push([...p, current[seg.value]]);
        continue;
      }
      if (seg.type === 'index') {
        if (!Array.isArray(current)) continue;
        if (seg.value < 0 || seg.value >= current.length) continue;
        next.push([...p, current[seg.value]]);
        continue;
      }
      if (seg.type === 'wildcard') {
        if (!Array.isArray(current)) continue;
        for (const item of current) next.push([...p, item]);
        continue;
      }
      if (seg.type === 'slice') {
        if (!Array.isArray(current)) continue;
        const start = seg.start === null ? 0 : Math.max(0, seg.start);
        const end = seg.end === null ? current.length : Math.min(current.length, seg.end);
        for (let i = start; i < end; i++) next.push([...p, current[i]]);
        continue;
      }
    }
    paths = next;
    if (paths.length === 0) return [];
  }
  return paths.map(p => p[p.length - 1]);
}

// Convenience: parse + evaluate in one call. Throws ParseError on
// parse failure, returns undefined if the path doesn't match.
function query(path, value) {
  const segs = parse(path);
  return evaluate(segs, value);
}

function queryAll(path, value) {
  const segs = parse(path);
  return evaluateAll(segs, value);
}

module.exports = {
  parse,
  evaluate,
  evaluateAll,
  query,
  queryAll,
  ParseError,
  TOKENS: T,
};
