// Homestead MCP server (PHA-1617.8).
//
// Streamable HTTP transport at POST /api/mcp (MCP spec 2025-06-18).
// JSON-RPC 2.0 messages in, JSON-RPC 2.0 messages out. Auth is the
// same middleware as the REST API (PAT bearer or session cookie);
// `req.session.user` is populated before the handler runs, so each
// tool/resource call is a thin wrapper over the existing REST endpoint
// reached via an internal HTTP loopback to the same server.
//
// Why HTTP loopback instead of importing the inline route handlers:
//   * Design doc §5 says "thin wrappers" — the wire shape is the spec.
//   * Zero refactor of the existing 1900-line server.js.
//   * Identical auth scoping, identical validation, identical response
//     shape, including the credential-leak guard on /api/events/merged.
//   * Cost is one localhost round-trip per tool call. Negligible for
//     a single-user agent, and acceptable to Brandon per the "do not
//     optimize for frugality" comment in §7.
//
// Why a separate module: the spec is its own thing (JSON-RPC envelope,
// tool registry, resource registry, capability negotiation). Keeping
// it out of server.js keeps the handler readable and lets the test
// file import the dispatch logic directly.

'use strict';

const http = require('http');
const url = require('url');
const { buildMergedVCalendar } = require('./mcp-ical');

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_NAME = 'homestead';
// Pulled from package.json at module load so the version bump in
// package.json flows through automatically.
const SERVER_VERSION = require('../package.json').version || '0.0.0';

// ---- JSON-RPC 2.0 helpers -------------------------------------------------

function jsonRpcOk(id, result) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function jsonRpcErr(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error: err };
}

// Spec-mandated error codes (JSON-RPC 2.0 + MCP additions).
const ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  // MCP-defined
  RESOURCE_NOT_FOUND: -32002,
};

// ---- Tool registry (design doc §5.2) --------------------------------------
//
// Each tool: { name, description, inputSchema (JSON Schema), handler(args, ctx) -> { content: [...] } }
//
// `ctx` carries the loopback primitives so the handler can call back to
// the local server. `ctx.user` is the authenticated session user.
//
// content blocks per the MCP spec:
//   { type: 'text', text: '...' }
//   { type: 'image', data: <base64>, mimeType: '...' }
//   { type: 'resource', resource: { uri, text|blob, mimeType } }
// We use `text` blocks for everything V0 — JSON.stringify the REST
// response so the agent gets structured data it can parse.

const TOOLS = [
  {
    name: 'homestead_get_me',
    description: 'Return the authenticated user profile snapshot (username, display, color, isAdmin, authProvider). Same shape as GET /api/me.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_args, ctx) => {
      // Construct from ctx.user (populated by the auth middleware) rather
      // than looping back to /api/me, which is NOT auth-gated and only
      // returns the user when a header-trust header is present. The shape
      // matches what /api/me returns under both session and PAT auth.
      const u = ctx.user;
      if (!u) {
        return { isError: true,
          content: [{ type: 'text', text: 'Error: no authenticated user' }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ user: u }, null, 2) }] };
    },
  },
  {
    name: 'homestead_list_tasks',
    description: 'List tasks. Maps to GET /api/tasks with optional assignee / due_before / include_done filters. Tasks owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        assignee: { type: 'string', description: 'Filter by assignee username or "all"' },
        due_before: { type: 'string', description: 'Filter to tasks with due_date <= YYYY-MM-DD' },
        include_done: { type: 'boolean', description: 'Include completed tasks (default false)', default: false },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const q = {};
      if (args.assignee) q.assignee = String(args.assignee);
      if (args.due_before) q.due_before = String(args.due_before);
      // include_done is honored at the tool layer: the underlying GET
      // /api/tasks returns all rows ordered done-first; filter client-
      // side rather than overloading the REST contract.
      let rows = await ctx.callApi('GET', '/api/tasks');
      if (args.due_before) rows = rows.filter(t => !t.due_date || t.due_date <= args.due_before);
      if (args.assignee) rows = rows.filter(t => t.assignee === args.assignee);
      if (!args.include_done) rows = rows.filter(t => !t.done);
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    },
  },
  {
    name: 'homestead_create_task',
    description: 'Create a task. Maps to POST /api/tasks. Required: title. Optional: notes, assignee (default "all"), due_date (YYYY-MM-DD), recur (daily|weekly|monthly), rotate (boolean), alt_assignee.',
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string', description: 'Task title' },
        notes: { type: 'string' },
        assignee: { type: 'string', description: 'Username or "all" (default "all")' },
        alt_assignee: { type: 'string', description: 'Alternate assignee for rotate=true' },
        due_date: { type: 'string', description: 'YYYY-MM-DD' },
        recur: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
        rotate: { type: 'boolean', description: 'Take-turns rotation between assignee and alt_assignee' },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const body = {};
      if (args.title !== undefined) body.title = args.title;
      if (args.notes !== undefined) body.notes = args.notes;
      if (args.assignee !== undefined) body.assignee = args.assignee;
      if (args.alt_assignee !== undefined) body.alt_assignee = args.alt_assignee;
      if (args.due_date !== undefined) body.due_date = args.due_date;
      if (args.recur !== undefined) body.recur = args.recur;
      if (args.rotate !== undefined) body.rotate = args.rotate ? 1 : 0;
      const created = await ctx.callApi('POST', '/api/tasks', body);
      return { content: [{ type: 'text', text: JSON.stringify(created, null, 2) }] };
    },
  },
  {
    name: 'homestead_update_task',
    description: 'Update a task. Maps to PUT /api/tasks/:id. Pass any subset of: title, notes, assignee, alt_assignee, due_date, recur, rotate.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'integer', description: 'Task id' },
        title: { type: 'string' },
        notes: { type: 'string' },
        assignee: { type: 'string' },
        alt_assignee: { type: 'string' },
        due_date: { type: 'string' },
        recur: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
        rotate: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const { id, ...patch } = args;
      if (patch.rotate !== undefined) patch.rotate = patch.rotate ? 1 : 0;
      const updated = await ctx.callApi('PUT', `/api/tasks/${id}`, patch);
      return { content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }] };
    },
  },
  {
    name: 'homestead_toggle_task',
    description: 'Toggle a task done/not-done. Maps to POST /api/tasks/:id/toggle. Handles take-turns rotation when the task has `recur` set.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'integer', description: 'Task id' } },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const updated = await ctx.callApi('POST', `/api/tasks/${args.id}/toggle`);
      return { content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }] };
    },
  },
  {
    name: 'homestead_list_events',
    description: 'List native events. Maps to GET /api/events. Optional: from / to (YYYY-MM-DD) for a date range.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date YYYY-MM-DD' },
        to: { type: 'string', description: 'End date YYYY-MM-DD' },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const q = {};
      if (args.from) q.from = args.from;
      if (args.to) q.to = args.to;
      const rows = await ctx.callApi('GET', '/api/events', null, q);
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    },
  },
  {
    name: 'homestead_create_event',
    description: 'Create a native event. Maps to POST /api/events. Required: title, date (YYYY-MM-DD). Optional: time (HH:MM), notes, owner (default "all").',
    inputSchema: {
      type: 'object',
      required: ['title', 'date'],
      properties: {
        title: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        time: { type: 'string', description: 'HH:MM (24h)' },
        notes: { type: 'string' },
        owner: { type: 'string', description: 'Username or "all"' },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const body = {};
      for (const k of ['title', 'date', 'time', 'notes', 'owner']) {
        if (args[k] !== undefined) body[k] = args[k];
      }
      const created = await ctx.callApi('POST', '/api/events', body);
      return { content: [{ type: 'text', text: JSON.stringify(created, null, 2) }] };
    },
  },
  {
    name: 'homestead_list_services',
    description: 'List service tiles. Maps to GET /api/services. Visibility: "mine" (default — owned by authenticated user), "shared" (owner="all"), "all" (everything).',
    inputSchema: {
      type: 'object',
      properties: {
        visibility: { type: 'string', enum: ['mine', 'shared', 'all'], default: 'mine' },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      let rows = await ctx.callApi('GET', '/api/services');
      const v = args.visibility || 'mine';
      const me = ctx.user.username;
      if (v === 'mine') rows = rows.filter(s => s.owner === me);
      else if (v === 'shared') rows = rows.filter(s => s.owner === 'all');
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    },
  },
];

// ---- Resource registry (design doc §5.3) ----------------------------------

const RESOURCES = [
  {
    uri: 'homestead://me',
    name: 'Authenticated user profile',
    description: 'The authenticated user snapshot (same as homestead_get_me). Useful for "am I logged in as the right user?" probes.',
    mimeType: 'application/json',
    handler: async (_args, ctx) => {
      // Construct from ctx.user (see homestead_get_me for rationale).
      const u = ctx.user;
      if (!u) {
        return {
          contents: [{
            uri: 'homestead://me',
            mimeType: 'application/json',
            text: JSON.stringify({ user: null, error: 'unauthenticated' }, null, 2),
          }],
        };
      }
      return {
        contents: [{
          uri: 'homestead://me',
          mimeType: 'application/json',
          text: JSON.stringify({ user: u }, null, 2),
        }],
      };
    },
  },
  {
    // Date range is generous (one year back, two years forward) so the
    // resource has a useful default without forcing the caller to
    // reason about windows. Agents that want a tighter window can
    // call homestead_list_events directly with from/to.
    uri: 'homestead://calendar/merged.ics',
    name: 'Merged calendar (RFC 5545 iCalendar)',
    description: 'Read-only VCALENDAR of the merged calendar: native events + cached provider events (CalDAV, MS Graph). Default range: today − 30 days to today + 90 days. Use homestead_list_events / getMergedCalendarIcs for arbitrary windows.',
    mimeType: 'text/calendar',
    handler: async (_args, ctx) => {
      const now = new Date();
      const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);
      const to = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);
      const data = await ctx.callApi('GET', '/api/events/merged', null, { from, to });
      const ics = buildMergedVCalendar(data.events || []);
      return {
        contents: [{
          uri: 'homestead://calendar/merged.ics',
          mimeType: 'text/calendar',
          text: ics,
        }],
      };
    },
  },
  {
    uri: 'homestead://activity/recent',
    name: 'Recent activity feed',
    description: 'Last 50 activity events. Backend depends on PHA-1622 (activity feed source) — currently returns an empty list with a structured "not yet implemented" marker so the resource shape is stable and clients can wire up before the backend lands.',
    mimeType: 'application/json',
    handler: async (_args, _ctx) => {
      return {
        contents: [{
          uri: 'homestead://activity/recent',
          mimeType: 'application/json',
          text: JSON.stringify({
            events: [],
            note: 'Activity feed not yet implemented — depends on PHA-1622.',
          }, null, 2),
        }],
      };
    },
  },
];

// ---- Internal HTTP loopback (server.js → itself) --------------------------
//
// `port` is read from app.settings (set by app.listen). `cookies` is the
// incoming request's session cookie (if any) so the loopback gets the
// same auth context. For PAT auth we forward the same Authorization
// header — authenticate() handles both.

function makeCallApi({ port, getCookies, getAuthHeader }) {
  return function callApi(method, pathname, body, query) {
    return new Promise((resolve, reject) => {
      const u = url.parse(pathname, true);
      const mergedQuery = Object.assign({}, u.query, query || {});
      const path = u.pathname + (Object.keys(mergedQuery).length
        ? '?' + new URLSearchParams(mergedQuery).toString()
        : '');
      const data = body !== undefined && body !== null ? JSON.stringify(body) : null;
      const headers = { 'Accept': 'application/json' };
      if (data) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(data);
      }
      const cookies = getCookies();
      if (cookies) headers['Cookie'] = cookies;
      const auth = getAuthHeader();
      if (auth) headers['Authorization'] = auth;
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers,
      }, res => {
        let chunks = '';
        res.on('data', c => { chunks += c; });
        res.on('end', () => {
          // 401 from authenticate() means the session/cookie went stale
          // mid-request. Surface as a structured MCP error so the agent
          // can decide to re-auth or abort.
          if (res.statusCode === 401) {
            return reject(Object.assign(new Error('unauthorized'), { code: 401, body: tryJson(chunks) }));
          }
          if (res.statusCode === 403) {
            return reject(Object.assign(new Error('forbidden'), { code: 403, body: tryJson(chunks) }));
          }
          if (res.statusCode === 404) {
            return reject(Object.assign(new Error('not found'), { code: 404, body: tryJson(chunks) }));
          }
          if (res.statusCode >= 400) {
            return reject(Object.assign(new Error(`status ${res.statusCode}`),
              { code: res.statusCode, body: tryJson(chunks) }));
          }
          if (!chunks) return resolve(null);
          // Some endpoints (e.g. /api/events/merged) return JSON; some
          // return arrays. Try JSON, fall back to text.
          const json = tryJson(chunks);
          if (json !== undefined) return resolve(json);
          resolve(chunks);
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  };
}

function tryJson(s) {
  try { return JSON.parse(s); } catch (_) { return undefined; }
}

// ---- JSON-RPC dispatcher --------------------------------------------------

function handleInitialize(id) {
  return jsonRpcOk(id, {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
    },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  });
}

function handleToolsList(id) {
  return jsonRpcOk(id, {
    tools: TOOLS.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  });
}

function handleResourcesList(id) {
  return jsonRpcOk(id, {
    resources: RESOURCES.map(r => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    })),
  });
}

// Validate args against a JSON Schema. We hand-roll a tiny validator
// for the v0 contract (type, required, enum, additionalProperties)
// rather than pulling in ajv — the schemas are small and the
// surface is stable. The contract error format matches MCP's
// INVALID_PARAMS convention.
function validateArgs(schema, args) {
  if (!schema) return null;
  if (schema.type === 'object') {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      return 'args must be an object';
    }
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in args)) return `missing required field: ${key}`;
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(args)) {
        if (!(key in schema.properties)) return `unexpected field: ${key}`;
      }
    }
    if (schema.properties) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (!(key in args)) continue;
        const v = args[key];
        const err = validateValue(sub, v, key);
        if (err) return err;
      }
    }
  }
  return null;
}

function validateValue(sub, v, key) {
  if (sub.type === 'string' && typeof v !== 'string') return `${key} must be a string`;
  if (sub.type === 'integer' && !(typeof v === 'number' && Number.isInteger(v))) return `${key} must be an integer`;
  if (sub.type === 'boolean' && typeof v !== 'boolean') return `${key} must be a boolean`;
  if (Array.isArray(sub.enum) && !sub.enum.includes(v)) return `${key} must be one of ${sub.enum.join(', ')}`;
  return null;
}

async function handleToolsCall(id, params, ctx) {
  const name = params && params.name;
  const args = params && params.arguments ? params.arguments : {};
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) return jsonRpcErr(id, ERR.METHOD_NOT_FOUND, `unknown tool: ${name}`);
  const err = validateArgs(tool.inputSchema, args);
  if (err) return jsonRpcErr(id, ERR.INVALID_PARAMS, err);
  try {
    const result = await tool.handler(args || {}, ctx);
    return jsonRpcOk(id, result);
  } catch (e) {
    // Forward upstream errors as MCP tool errors (NOT JSON-RPC errors).
    // Per spec: tool execution failures come back as `isError: true`
    // so the client can decide whether to retry or surface.
    const data = { code: e.code, name: e.name };
    if (e.body) data.body = e.body;
    return jsonRpcOk(id, {
      isError: true,
      content: [{ type: 'text', text: `Error: ${e.message}` }],
      _meta: data,
    });
  }
}

async function handleResourcesRead(id, params, ctx) {
  const uri = params && params.uri;
  const r = RESOURCES.find(r => r.uri === uri);
  if (!r) return jsonRpcErr(id, ERR.RESOURCE_NOT_FOUND, `unknown resource: ${uri}`);
  try {
    const result = await r.handler(params || {}, ctx);
    return jsonRpcOk(id, result);
  } catch (e) {
    return jsonRpcErr(id, ERR.INTERNAL, `resource read failed: ${e.message}`);
  }
}

// ---- Public entry point ---------------------------------------------------

// `req` is the express request after `authenticate` has populated
// `req.session.user`. `res` is the express response.
function makeHandler(port) {
  // Bind the loopback to the same port the server is listening on.
  // `port` is captured at handler construction; server.js passes it
  // when the bound port is known (after listen).
  const callApi = makeCallApi({
    port,
    getCookies: () => null, // overridden per-request below
    getAuthHeader: () => null,
  });

  return async function mcpHandler(req, res) {
    // The body is already parsed by express.json() before this runs.
    // Per spec, requests are JSON-RPC 2.0 messages (single or batch).
    const body = req.body;
    if (body === undefined || body === null) {
      return sendJsonRpc(res, jsonRpcErr(null, ERR.INVALID_REQUEST, 'empty body'));
    }
    const messages = Array.isArray(body) ? body : [body];
    if (messages.length === 0) {
      return sendJsonRpc(res, jsonRpcErr(null, ERR.INVALID_REQUEST, 'empty batch'));
    }

    // Build per-request context. Forward the session cookie so the
    // loopback preserves the session, AND forward the Authorization
    // header for PAT auth — middleware handles both.
    const cookies = req.headers.cookie || null;
    const authHeader = req.headers.authorization || null;
    const user = req.session && req.session.user ? req.session.user : null;
    const ctx = {
      user,
      callApi(method, pathname, body, query) {
        // Rebind the loopback's cookie/auth getter to this request's
        // values. (The closure captures the per-request `cookies` and
        // `authHeader`; the underlying `callApi` is the one we built
        // above with the right port.)
        return callApi(method, pathname, body, query);
      },
    };
    // Override the getters inside callApi directly so the per-request
    // cookies/auth flow through. Re-create callApi with the request's
    // bound values via a fresh closure.
    const boundCallApi = makeCallApi({
      port,
      getCookies: () => cookies,
      getAuthHeader: () => authHeader,
    });
    ctx.callApi = boundCallApi;

    const responses = [];
    for (const msg of messages) {
      if (!msg || msg.jsonrpc !== '2.0') {
        responses.push(jsonRpcErr(msg && msg.id, ERR.INVALID_REQUEST, 'not a JSON-RPC 2.0 message'));
        continue;
      }
      // Notifications (no `id`) get no response.
      if (msg.id === undefined) {
        if (msg.method === 'notifications/initialized') {
          // Client signaled it's done with the handshake. No-op for v0.
          continue;
        }
        if (msg.method === 'notifications/cancelled') {
          // Client cancelled an in-flight request. v0 has no streaming
          // so nothing to cancel; accept and drop.
          continue;
        }
        // Unknown notification — silently drop per spec.
        continue;
      }
      responses.push(await dispatch(msg, ctx));
    }

    if (responses.length === 0) {
      // All messages were notifications — 202 Accepted with no body.
      res.status(202).end();
      return;
    }
    const payload = messages.length === 1 ? responses[0] : responses;
    sendJsonRpc(res, payload);
  };
}

async function dispatch(msg, ctx) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return handleInitialize(id);
    case 'ping':
      return jsonRpcOk(id, {});
    case 'tools/list':
      return handleToolsList(id);
    case 'tools/call':
      return await handleToolsCall(id, params, ctx);
    case 'resources/list':
      return handleResourcesList(id);
    case 'resources/read':
      return await handleResourcesRead(id, params, ctx);
    default:
      return jsonRpcErr(id, ERR.METHOD_NOT_FOUND, `unknown method: ${method}`);
  }
}

function sendJsonRpc(res, payload) {
  // Per MCP spec: include `Mcp-Session-Id` if stateful; we are
  // stateless (no session continuity required), so just JSON.
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(JSON.stringify(payload));
}

// ---- Express route factory -----------------------------------------------

// Build the route handlers. `getPort` is a function () => number that
// returns the bound port. server.js wires `getPort` to read from
// `server.address().port` after listen.
function routes(getPort) {
  function postHandler(req, res, next) {
    // Populate the handler with the current port. We rebuild the
    // handler per-request so the loopback port is always fresh.
    const port = getPort();
    if (!port) {
      return res.status(503).json({ error: 'mcp_unbound', message: 'server port not yet known' });
    }
    return makeHandler(port)(req, res, next);
  }
  return {
    post: postHandler,
    // GET is for the SSE-side of streamable-HTTP. v0 returns JSON
    // only, so GET is a 405 with an Allow header pointing to POST.
    get: (_req, res) => {
      res.setHeader('Allow', 'POST');
      res.status(405).json({ error: 'method_not_allowed', allow: 'POST' });
    },
  };
}

module.exports = {
  PROTOCOL_VERSION,
  SERVER_NAME,
  SERVER_VERSION,
  TOOLS,
  RESOURCES,
  routes,
  // exported for unit tests
  validateArgs,
  dispatch,
  makeHandler,
};
