// Homestead server-side Hearth agent runtime (PHA-2827.C).
//
// The Agent module today (lib/drawer-dispatch.js, PHA-1617.6) POSTs every
// drawer message to a user-configured external URL. When the user's
// character is `hearth` (the default character seeded by
// lib/hearth-characters.js, PHA-2827.B) AND a model provider is configured
// (BYOK agent_tokens row OR a server-staged `HEARTH_*_KEY` env var), the
// dispatcher short-circuits that external POST and routes the message
// through this module instead.
//
// Three responsibilities:
//
//   1. resolveProvider(opts) — pick which provider / model / key to use
//      based on BYOK first, server-staged env fallback. No key → returns
//      `{ ok: false, reason: 'no_key' }` so the dispatcher can surface a
//      "Hearth needs a model key" message in the drawer UI (issue
//      acceptance: negative case 3).
//
//   2. createProvider({ provider, baseUrl, apiKey, model, ... }) — build a
//      thin async-iterable adapter around the configured LLM endpoint.
//      Supports anthropic-proxy, litellm, and OpenAI direct. All three
//      talk the same OpenAI-compatible chat-completions wire (litellm
//      speaks it natively; the anthropic-proxy bridge translates SSE;
//      OpenAI direct is the reference). Yields:
//
//        { type: 'text',   text }      — incremental text chunk
//        { type: 'done',   text, tokens_in, tokens_out } — terminal
//        { type: 'error',  error }    — surfaced as a `failed` result
//
//      The shape is what the dispatcher's SSE parser (§6.2) already
//      consumes (`event: chunk` / `event: done`), so the runtime emits
//      into the same wire contract the route layer streams back to the
//      browser.
//
//   3. loadSystemPrompt({ soulPath, identityPath }) — read SOUL.md at
//      boot (memoized by file sha). Falls back to a tiny built-in
//      placeholder only when the file is missing — the runtime is not
//      usable without Hearth's voice, and a placeholder message keeps
//      CI hermetic.
//
// Pure logic — no HTTP server, no DB schema. Imported by:
//   * lib/drawer-dispatch.js (dispatcher short-circuit)
//   * scripts/test-2827c-server-runtime.js (acceptance)
//
// The runtime is intentionally NOT wired into the analytics capture
// directly — that's the dispatcher's job (drawer_call_started /
// completed / failed). Keeping the runtime provider-pure means tests
// can stub it without touching analytics.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');

const CHAR_KEY_HEARTH = 'hearth';

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------
//
// Reads SOUL.md (and IDENTITY.md if present) once at boot. Memoized by
// file content sha so future edits to the personality file invalidate the
// cache without a process restart — the next call sees the new sha and
// re-reads. This matters because the SOUL.md is canon for the household
// (per PHA-2828); edits to it should be live, not gated on a deploy.
//
// `loadSystemPrompt()` returns { text, soulSha, identitySha, soulPath,
// identityPath }. Tests stub via `__test__.setSystemPromptLoader(...)`.

let _loader = defaultLoader;

function defaultLoader() {
  // agents/hearth/ lives at <repo>/agents/hearth (per A's PR #106).
  // Resolve relative to this file so the runtime works whether server.js
  // runs from the repo root or from a packaged container.
  const repoRoot = path.join(__dirname, '..');
  const soulPath = path.join(repoRoot, 'agents', 'hearth', 'SOUL.md');
  const identityPath = path.join(repoRoot, 'agents', 'hearth', 'IDENTITY.md');

  const soulText = readSafely(soulPath);
  const identityText = readSafely(identityPath);
  const soulSha = shaOf(soulText);
  const identitySha = shaOf(identityText);

  if (!soulText) {
    // No canon file present. Surface a tiny, unmistakable placeholder so
    // tests that ship before PHA-2828 lands still have something. The
    // dispatcher never reaches the provider if `resolveProvider` returns
    // no_key, so this only fires when a key IS configured but SOUL.md is
    // missing — a deliberate boot-time footgun.
    return {
      text: '[Hearth system prompt unavailable — agents/hearth/SOUL.md is missing]',
      soulSha: '',
      identitySha: '',
      soulPath,
      identityPath,
    };
  }

  // Concatenate SOUL.md + IDENTITY.md frontmatter. IDENTITY.md gives
  // Hearth its name, emoji, voice/TTS, avatar — useful grounding for the
  // model that SOUL.md alone doesn't carry.
  const parts = [];
  if (soulText) parts.push('# SOUL.md\n\n' + soulText);
  if (identityText) parts.push('# IDENTITY.md\n\n' + identityText);
  return {
    text: parts.join('\n\n---\n\n'),
    soulSha,
    identitySha,
    soulPath,
    identityPath,
  };
}

// Read a file; missing files return empty string (sha of empty == the
// well-known constant). Anything else propagates.
function readSafely(absPath) {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return '';
    throw err;
  }
}

function shaOf(text) {
  if (!text) return '';
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function loadSystemPrompt() {
  const r = _loader();
  return r;
}

// ---------------------------------------------------------------------------
// Key resolution
// ---------------------------------------------------------------------------
//
// resolveKey({ userId, provider }) returns { apiKey, source } where:
//   source === 'byok'           — token from agent_tokens for this user
//   source === 'server_staged'  — HEARTH_<PROVIDER>_KEY env var
//   source === null             — no key available (caller should surface
//                                "Hearth needs a model key" message)
//
// BYOK is checked first. Users who bring their own key always win over
// the server-staged fallback (no surprise about which credential funded
// a request). Token authentication for BYOK is intentionally NOT
// re-using `agent_tokens.verify` — those are Homestead PATs used by
// external apps, not LLM-provider API keys. The BYOK model key is
// stored as a per-user secret in `agent_token_secrets` (key/value) so
// we can rotate it without churning the PAT. For now, this module
// accepts a key passed in opts.key (the dispatcher / route layer
// resolves it from the user's row); we don't read the DB here.
//
// The function is intentionally a pure resolver: it does NOT make
// network calls. Tests stub it via `__test__.setKeyResolver(...)`.

const SUPPORTED_PROVIDERS = new Set(['anthropic-proxy', 'litellm', 'openai']);

function pickServerStagedKey(provider) {
  const p = String(provider || '').toLowerCase();
  if (p === 'anthropic-proxy') {
    return process.env.HEARTH_ANTHROPIC_PROXY_KEY
      || process.env.HEARTH_ANTHROPIC_KEY
      || process.env.ANTHROPIC_API_KEY
      || process.env.ANTHROPIC_AUTH_TOKEN
      || '';
  }
  if (p === 'openai') {
    return process.env.HEARTH_OPENAI_KEY
      || process.env.OPENAI_API_KEY
      || '';
  }
  if (p === 'litellm') {
    return process.env.HEARTH_LITELLM_KEY
      || process.env.LITELLM_API_KEY
      || '';
  }
  return '';
}

function pickServerStagedBaseUrl(provider) {
  const p = String(provider || '').toLowerCase();
  if (p === 'anthropic-proxy') {
    return process.env.HEARTH_ANTHROPIC_PROXY_URL
      || process.env.ANTHROPIC_PROXY_URL
      || 'http://10.0.0.100:4011';
  }
  if (p === 'litellm') {
    return process.env.HEARTH_LITELLM_URL
      || process.env.LITELLM_BASE_URL
      || 'http://10.0.0.100:4000';
  }
  if (p === 'openai') {
    return process.env.HEARTH_OPENAI_BASE_URL
      || process.env.OPENAI_BASE_URL
      || 'https://api.openai.com';
  }
  return '';
}

function pickServerStagedModel(provider) {
  const p = String(provider || '').toLowerCase();
  if (p === 'anthropic-proxy') {
    return process.env.HEARTH_ANTHROPIC_PROXY_MODEL || process.env.HEARTH_MODEL || 'claude-sonnet-5';
  }
  if (p === 'litellm') {
    return process.env.HEARTH_LITELLM_MODEL || process.env.HEARTH_MODEL || 'litellm/anthropic/claude-sonnet-5';
  }
  if (p === 'openai') {
    return process.env.HEARTH_OPENAI_MODEL || process.env.HEARTH_MODEL || 'gpt-5.6';
  }
  return '';
}

let _keyResolver = defaultResolver;

function defaultResolver(opts) {
  const provider = opts && opts.provider;
  if (!provider || !SUPPORTED_PROVIDERS.has(String(provider).toLowerCase())) {
    return { apiKey: '', source: null, reason: 'unsupported_provider' };
  }
  // BYOK wins.
  if (opts && typeof opts.byokKey === 'string' && opts.byokKey.trim()) {
    return { apiKey: opts.byokKey.trim(), source: 'byok' };
  }
  const envKey = pickServerStagedKey(provider);
  if (envKey) return { apiKey: envKey, source: 'server_staged' };
  return { apiKey: '', source: null, reason: 'no_key' };
}

function resolveKey(opts) {
  return _keyResolver(opts || {});
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------
//
// createProvider({ provider, baseUrl, apiKey, model, maxTokens, system,
// fetchImpl }) returns a provider object with:
//
//   stream(messages, { signal }) -> async iterable of
//     { type: 'text', text }
//     { type: 'done', text, tokens_in, tokens_out }
//     { type: 'error', error }
//
// All three providers share the same OpenAI-compatible chat-completions
// wire (HTTP POST + Bearer + SSE stream of `data: {...}\n\n`). The
// anthropic-proxy bridge from MiniMax translates its native SSE into
// this shape server-side, so a single consumer handles all three.
//
// `fetchImpl` is the test seam: tests pass a stub that yields canned
// SSE blocks without touching the network. Production uses the global
// `fetch` (Node >= 22 has it natively).
//
// `maxTokens` defaults to 1024. Tests can override.

function createProvider(cfg) {
  if (!cfg || typeof cfg !== 'object') {
    throw new Error('createProvider: cfg is required');
  }
  const provider = String(cfg.provider || '').toLowerCase();
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw new Error(`createProvider: unsupported provider "${cfg.provider}"`);
  }
  if (!cfg.apiKey) throw new Error('createProvider: apiKey is required');
  if (!cfg.baseUrl) throw new Error('createProvider: baseUrl is required');
  if (!cfg.model) throw new Error('createProvider: model is required');

  const baseUrl = cfg.baseUrl.replace(/\/+$/, '');
  const maxTokens = Number.isFinite(cfg.maxTokens) ? cfg.maxTokens : 1024;
  const fetchImpl = cfg.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) throw new Error('createProvider: no fetch available');

  return {
    provider,
    model: cfg.model,
    maxTokens,
    async *stream(messages, opts = {}) {
      const body = {
        model: cfg.model,
        stream: true,
        max_tokens: maxTokens,
        messages: [
          ...(cfg.system ? [{ role: 'system', content: cfg.system }] : []),
          ...messages.map((m) => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content : (m.content || ''),
          })),
        ],
      };

      let res;
      try {
        res = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${cfg.apiKey}`,
            'Accept': 'text/event-stream',
          },
          body: JSON.stringify(body),
          signal: opts.signal || null,
        });
      } catch (e) {
        yield { type: 'error', error: `connect_error:${e && e.message || 'unknown'}` };
        return;
      }

      if (!res || !res.ok) {
        let detail = '';
        try { detail = await (res && res.text ? res.text() : ''); } catch (_) { /* ignore */ }
        yield {
          type: 'error',
          error: `http_status:${res ? res.status : 'no_response'}`,
          detail: detail ? detail.slice(0, 500) : '',
        };
        return;
      }

      // Stream the SSE body line-by-line.
      const reader = res.body && res.body.getReader ? res.body.getReader() : null;
      if (!reader) {
        yield { type: 'error', error: 'no_stream' };
        return;
      }
      const decoder = new TextDecoder('utf8');
      let buf = '';
      let fullText = '';
      let tokensIn = null;
      let tokensOut = null;
      let finished = false;

      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = parseSseBlock(block);
          if (!ev) continue;
          if (ev.event === 'error' || (ev.data && ev.data.error)) {
            yield { type: 'error', error: 'sse_error_event', detail: JSON.stringify(ev.data || ev) };
            return;
          }
          // OpenAI-compatible chat-completions delta payload:
          //   { choices: [{ delta: { content: "..." }, finish_reason: null|"stop" }] }
          //   usage arrives in a final chunk or in `x`/usage payloads depending on provider.
          const choice = ev.data && ev.data.choices && ev.data.choices[0];
          const piece = choice && choice.delta && typeof choice.delta.content === 'string'
            ? choice.delta.content : '';
          if (piece) {
            fullText += piece;
            yield { type: 'text', text: piece };
          }
          if (ev.data && ev.data.usage) {
            if (typeof ev.data.usage.prompt_tokens === 'number') tokensIn = ev.data.usage.prompt_tokens;
            if (typeof ev.data.usage.completion_tokens === 'number') tokensOut = ev.data.usage.completion_tokens;
          }
          if (choice && (choice.finish_reason === 'stop' || choice.finish_reason === 'length')) {
            finished = true;
          }
        }
      }

      yield {
        type: 'done',
        text: fullText,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
      };
    },
  };
}

// Parse one SSE block (`event:` + `data:` lines separated by blank line).
// Mirrors the parser in lib/drawer-dispatch.js §6.2 so the runtime's
// output can be re-fed into that parser unchanged when needed.
function parseSseBlock(block) {
  let event = 'message';
  const dataLines = [];
  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let val = colon === -1 ? '' : line.slice(colon + 1);
    if (val.startsWith(' ')) val = val.slice(1);
    if (field === 'event') event = val;
    else if (field === 'data') dataLines.push(val);
  }
  if (!dataLines.length && event === 'message') return null;
  const joined = dataLines.join('\n');
  if (joined === '[DONE]') return { event: 'done', data: {} };
  let parsed = joined;
  try { parsed = JSON.parse(joined); } catch (_) { /* keep as string */ }
  return { event, data: parsed };
}

// ---------------------------------------------------------------------------
// Top-level: dispatchHearth({ db, me, message, conversationId, requestId,
//   view, snapshotPayload, byokKey })
//
// Orchestrates resolveProvider + loadSystemPrompt + provider.stream() into
// the same `{ ok, kind, text, tokens_in, tokens_out, ... }` shape the
// dispatcher returns to the route. The dispatcher calls this in place of
// its external POST when the user is the default Hearth character AND a
// key is configured.
//
// This function does NOT call analytics — the dispatcher wraps the call
// with `drawer_call_started` (before) and `drawer_call_completed/failed`
// (after) so analytics are recorded exactly once per dispatch (matching
// the existing wire path).
//
// `providerCfg` (optional) overrides the env-driven defaults. Tests pass
// `providerCfg` with a stubbed `fetchImpl` to hermetic-fake the network.

async function dispatchHearth(opts) {
  const {
    db,
    me,
    message,
    conversationId,
    requestId,
    view = 'drawer',
    snapshotPayload = null,
    byokKey = '',
    providerCfg = null,
  } = opts || {};

  if (!me || !Number.isInteger(me.id)) {
    return { ok: false, status: 'no_user', lastError: 'no_user' };
  }

  // Provider selection: caller may pre-resolve (tests), otherwise fall
  // back to env defaults. The dispatcher's `resolveProvider` is the
  // canonical entry point — this is a thin shim so tests can call the
  // runtime directly without spinning the dispatcher.
  let cfg = providerCfg;
  if (!cfg) {
    const provider = process.env.HEARTH_PROVIDER || 'litellm';
    const baseUrl = pickServerStagedBaseUrl(provider);
    const model = pickServerStagedModel(provider);
    const key = resolveKey({ provider, byokKey });
    if (!key.apiKey) {
      return {
        ok: false,
        status: 'no_key',
        lastError: key.reason || 'no_key',
        kind: 'hearth_no_key',
      };
    }
    cfg = { provider, baseUrl, apiKey: key.apiKey, model };
  }

  const prompt = loadSystemPrompt();
  const providerObj = createProvider({
    provider: cfg.provider,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    maxTokens: cfg.maxTokens,
    system: prompt.text,
    fetchImpl: cfg.fetchImpl,
  });

  const userMsg = {
    role: 'user',
    content: message || '',
  };

  let fullText = '';
  let tokensIn = null;
  let tokensOut = null;
  let firstError = null;
  let chunks = 0;

  try {
    for await (const ev of providerObj.stream([userMsg])) {
      if (ev.type === 'text') {
        fullText += ev.text;
        chunks++;
      } else if (ev.type === 'done') {
        tokensIn = (typeof ev.tokens_in === 'number') ? ev.tokens_in : tokensIn;
        tokensOut = (typeof ev.tokens_out === 'number') ? ev.tokens_out : tokensOut;
      } else if (ev.type === 'error') {
        firstError = firstError || ev;
        break;
      }
    }
  } catch (e) {
    firstError = firstError || { type: 'error', error: `stream_throw:${e && e.message || 'unknown'}` };
  }

  if (firstError) {
    return {
      ok: false,
      status: 'provider_error',
      lastError: firstError.error,
      lastStatus: firstError.error && firstError.error.startsWith('http_status')
        ? Number(firstError.error.slice('http_status:'.length).split(' ')[0]) || null : null,
      detail: firstError.detail || null,
      requestId,
      conversationId,
    };
  }

  return {
    ok: true,
    kind: 'json',
    requestId,
    conversationId,
    text: fullText,
    tokensIn,
    tokensOut,
    chunks,
    providerKeySource: cfg.keySource || 'server_staged',
    soulSha: prompt.soulSha,
  };
}

module.exports = {
  CHAR_KEY_HEARTH,
  SUPPORTED_PROVIDERS,
  loadSystemPrompt,
  resolveKey,
  pickServerStagedKey,
  pickServerStagedBaseUrl,
  pickServerStagedModel,
  createProvider,
  dispatchHearth,
  parseSseBlock,
  __test__: {
    setSystemPromptLoader(fn) { _loader = fn; },
    resetSystemPromptLoader() { _loader = defaultLoader; },
    setKeyResolver(fn) { _keyResolver = fn; },
    resetKeyResolver() { _keyResolver = defaultResolver; },
    shaOf,
    readSafely,
  },
};
