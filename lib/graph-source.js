// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 PHATT Tech LLC

// Homestead — Microsoft Graph source adapter (PHA-1864 / PHA-1620a).
//
// First-cut adapter behind the same CalendarSource contract as the
// CalDAV adapter (see lib/calendar-sources.js). Talks to Microsoft
// Graph at https://graph.microsoft.com/v1.0/ using an OAuth2 access
// token + refresh token supplied by the per-user calendar_sources
// row's encrypted cred_blob.
//
// Endpoints used (read path — Phase 2 will add write-back):
//   GET /me/calendars                — list calendars
//   GET /me/calendarView?startDateTime=&endDateTime=
//                                   — window-bounded event list
//                                    (server-side time-range filter;
//                                    cheaper than /me/events for
//                                    month-grid reads)
//   POST /oauth2/v2.0/token         — refresh-token grant, used when
//                                    the stored access_token is past
//                                    `expires_at`
//
// The HTTP layer is parameterized via the `httpDo` dependency so
// tests can inject canned responses (no real Graph calls in CI).
// Production passes a tiny https-backed helper that mirrors the
// CalDAV adapter's defaultHttpDo.
//
// Credentials shape (the JSON we encrypt into cred_blob):
//   {
//     access_token:  '<jwt-ish opaque token>',
//     refresh_token: '<opaque refresh>',
//     expires_at:    '2026-08-09T20:00:00.000Z' | null,
//     client_id:     '<azure-app-client-id>'    | null,
//     tenant_id:     '<azure-tenant-id-or-common>' | null,
//     scope:         'Calendars.Read offline_access' | null,
//   }
// The fields marked `| null` are optional but required for the
// refresh path; tests pass a stub that never triggers refresh.

'use strict';

// --- Default HTTPS-backed HTTP helper ----------------------------------

function defaultHttpDo({ method, url, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? require('http') : require('https');
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers: { ...headers },
    };
    // Form-encoded bodies (token refresh) need a Content-Length.
    if (body != null && !('content-length' in opts.headers)) {
      const buf = Buffer.from(body, 'utf8');
      opts.headers['Content-Length'] = buf.length;
      body = buf;
    }
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: buf.toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

// --- Token refresh ------------------------------------------------------

// tokenIsExpired(tokenState) returns true when the stored access_token
// is past its expiry (or expiry is missing — safer to refresh than to
// risk a 401 mid-page). `now` is injectable for tests.
function tokenIsExpired(tokenState, now = new Date()) {
  if (!tokenState || !tokenState.expires_at) return true;
  const t = new Date(tokenState.expires_at).getTime();
  if (isNaN(t)) return true;
  // 60-second skew buffer so a token that JUST expired still gets a
  // refresh attempt rather than a guaranteed 401 round-trip.
  return now.getTime() >= (t - 60_000);
}

// refreshAccessToken(tokenState, httpDo) exchanges the refresh_token
// for a fresh access_token via Azure AD's v2.0 token endpoint. Returns
// a NEW tokenState object — the caller is responsible for re-encrypting
// it back into cred_blob (calendar-sources.js owns that flow).
//
// Required config: tenant_id (or 'common'), client_id, refresh_token.
// If any are missing, throws — better to surface the misconfiguration
// than to ship a perpetually-broken adapter.
async function refreshAccessToken(tokenState, httpDo = defaultHttpDo, tokenEndpoint) {
  if (!tokenState) throw new Error('refreshAccessToken: tokenState is required');
  const { refresh_token, client_id, tenant_id, scope } = tokenState;
  if (!refresh_token) throw new Error('refreshAccessToken: refresh_token is required');
  if (!client_id) throw new Error('refreshAccessToken: client_id is required (set during source creation)');
  const tenant = tenant_id || 'common';
  const endpoint = tokenEndpoint || `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
  const form = new URLSearchParams({
    client_id,
    grant_type: 'refresh_token',
    refresh_token,
  });
  if (scope) form.set('scope', scope);
  const r = await httpDo({
    method: 'POST',
    url: endpoint,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: form.toString(),
  });
  if (r.status < 200 || r.status >= 300) {
    // Trim the response body — refresh failures echo the refresh_token
    // back in some error envelopes, which we must NOT let leak.
    throw new Error(`GraphSource: token refresh failed (status ${r.status})`);
  }
  let parsed;
  try { parsed = JSON.parse(r.body); }
  catch (e) {
    throw new Error('GraphSource: token refresh returned non-JSON: ' + e.message);
  }
  if (!parsed.access_token) {
    throw new Error('GraphSource: token refresh response missing access_token');
  }
  const expiresIn = Number(parsed.expires_in || 3600);
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  return {
    access_token: parsed.access_token,
    refresh_token: parsed.refresh_token || refresh_token,
    expires_at: expiresAt,
    client_id,
    tenant_id,
    scope,
  };
}

// --- Adapter factory ----------------------------------------------------
//
// `config` is the calendar_sources row's "creds + endpoint" payload
//   * provider:    'ms365'
//   * account_id:  the user's UPN / email (informational; Graph uses
//                  /me/* scoped to whatever token was issued)
//   * base_url:    optional override for Graph base (default
//                  https://graph.microsoft.com/v1.0)
//   * access_token, refresh_token, expires_at, client_id, tenant_id,
//     scope (all required for the refresh path; tests stub httpDo
//     and inject a never-expiring token to skip it)
//
// Returns an object with listCalendars() and listEvents(range) plus
// Phase-2 write stubs that throw "not implemented" — same shape as
// CalDAVSource so the merge layer doesn't care which adapter produced
// the events.
function makeGraphSource(config, deps = {}) {
  if (!config || !config.provider) {
    throw new Error('GraphSource: config.provider is required');
  }
  if (config.provider !== 'ms365') {
    throw new Error(`GraphSource: unknown provider "${config.provider}"`);
  }
  if (!config.access_token) {
    throw new Error('GraphSource: config.access_token is required');
  }
  const httpDo = deps.httpDo || defaultHttpDo;
  const baseUrl = (config.base_url || 'https://graph.microsoft.com/v1.0').replace(/\/$/, '');
  const tokenState = {
    access_token: config.access_token,
    refresh_token: config.refresh_token || null,
    expires_at: config.expires_at || null,
    client_id: config.client_id || null,
    tenant_id: config.tenant_id || null,
    scope: config.scope || null,
  };
  const tokenEndpoint = deps.tokenEndpoint || null;
  // onTokenRefresh is an optional hook so calendar-sources.js can
  // re-encrypt and persist a rotated token without coupling this
  // module to the database layer. Tests pass a spy.
  const onTokenRefresh = deps.onTokenRefresh || (async () => {});

  // graphFetch wraps httpDo with bearer auth + automatic refresh.
  async function graphFetch(method, path, { body, headers, query } = {}) {
    if (tokenIsExpired(tokenState)) {
      if (tokenState.refresh_token && tokenState.client_id) {
        const fresh = await refreshAccessToken(tokenState, httpDo, tokenEndpoint);
        Object.assign(tokenState, fresh);
        await onTokenRefresh(fresh);
      } else {
        throw new Error('GraphSource: access_token expired and no refresh_token available');
      }
    }
    let url = baseUrl + path;
    if (query && Object.keys(query).length) {
      const qs = new URLSearchParams(query);
      url += (url.includes('?') ? '&' : '?') + qs.toString();
    }
    const reqHeaders = {
      Authorization: 'Bearer ' + tokenState.access_token,
      Accept: 'application/json',
      ...headers,
    };
    const r = await httpDo({
      method,
      url,
      headers: reqHeaders,
      body: body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    if (r.status === 401 && tokenState.refresh_token && tokenState.client_id) {
      // Server told us the token is bad anyway — refresh and retry once.
      const fresh = await refreshAccessToken(tokenState, httpDo, tokenEndpoint);
      Object.assign(tokenState, fresh);
      await onTokenRefresh(fresh);
      const r2 = await httpDo({
        method,
        url,
        headers: {
          ...reqHeaders,
          Authorization: 'Bearer ' + tokenState.access_token,
        },
        body: body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body)),
      });
      return r2;
    }
    return r;
  }

  async function listCalendars() {
    const r = await graphFetch('GET', '/me/calendars');
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`GraphSource: GET /me/calendars failed (status ${r.status})`);
    }
    let parsed;
    try { parsed = JSON.parse(r.body); }
    catch (e) { throw new Error('GraphSource: /me/calendars returned non-JSON: ' + e.message); }
    const items = Array.isArray(parsed.value) ? parsed.value : [];
    return items.map((c) => ({
      id: c.id,
      href: c.id, // Graph "calendar id" is the calendarHref form
      displayName: c.name || c.id,
      color: c.color || null,
      canEdit: !!c.canEdit,
      isDefault: !!c.isDefaultCalendar,
    }));
  }

  async function listEvents({ start, end, calendarHref } = {}) {
    if (!start || !end) throw new Error('listEvents: start and end (ISO 8601) are required');
    // calendarHref is the Graph calendar id (e.g. "AAMkAGI1..."); when
    // absent we fall through to the user's default calendar via
    // /me/calendarView (which respects the user's "show events from"
    // preferences).
    const path = calendarHref
      ? `/me/calendars/${encodeURIComponent(calendarHref)}/calendarView`
      : '/me/calendarView';
    const events = [];
    let url = null;
    let pageCount = 0;
    do {
      const r = url
        ? await httpDo({
            method: 'GET',
            url,
            headers: {
              Authorization: 'Bearer ' + tokenState.access_token,
              Accept: 'application/json',
            },
          })
        : await graphFetch('GET', path, {
            query: {
              startDateTime: start,
              endDateTime: end,
              $orderby: 'start/dateTime',
              $top: '100',
            },
            headers: {
              // Prefer a stable, bounded page size; OData default is 100
              // but the Graph server may negotiate up. Keeping it small
              // also caps memory in the rare all-day recurring cases.
              Prefer: 'odata.maxpagesize=100',
            },
          });
      if (r.status < 200 || r.status >= 300) {
        throw new Error(`GraphSource: calendarView failed (status ${r.status})`);
      }
      let parsed;
      try { parsed = JSON.parse(r.body); }
      catch (e) { throw new Error('GraphSource: calendarView returned non-JSON: ' + e.message); }
      const items = Array.isArray(parsed.value) ? parsed.value : [];
      for (const ev of items) events.push(mapEvent(ev));
      url = parsed['@odata.nextLink'] || null;
      pageCount++;
      // Safety brake — the month-grid path should never paginate more
      // than a handful of times. If we're spinning, fail loudly so the
      // sync orchestrator can mark the source stale instead of hanging.
      if (pageCount > 20) {
        throw new Error('GraphSource: calendarView exceeded 20 pages, aborting');
      }
    } while (url);
    return events;
  }

  return {
    kind: 'graph',
    provider: config.provider,
    account_id: config.account_id || null,
    // listCalendars is implemented but not currently exercised by the
    // PHA-1620 read-through path (which is wired to a pre-configured
    // calendar_id). Kept on the interface so the Phase-2 setup UI can
    // discover Graph calendars the same way it will discover CalDAV.
    listCalendars,
    listEvents,
    // Phase 2 stubs (not implemented in this first-cut):
    createEvent: async () => { throw new Error('GraphSource.createEvent: Phase 2, not implemented'); },
    updateEvent: async () => { throw new Error('GraphSource.updateEvent: Phase 2, not implemented'); },
    deleteEvent: async () => { throw new Error('GraphSource.deleteEvent: Phase 2, not implemented'); },
  };
}

// mapEvent converts a Microsoft Graph event payload into the shape
// calendar-sources.syncSource() expects:
//   { externalId, title, description, start, end, allDay, location, href, etag }
// All fields are strings or nulls — no Date objects, no provider
// enums. Graph's start.dateTime / end.dateTime are floating-local
// (no Z suffix), so we anchor them as ISO-with-offset and let the
// client / month grid deal with timezone math.
function mapEvent(ev) {
  const start = graphDateTimeToIso(ev.start);
  const end = graphDateTimeToIso(ev.end);
  const isAllDay = !!ev.isAllDay;
  return {
    externalId: ev.id || null,
    etag: ev['@odata.etag'] || ev.changeKey || null,
    title: ev.subject || '(untitled)',
    description: ev.bodyPreview || ev.body?.content || '',
    location: ev.location?.displayName || '',
    start,
    end,
    allDay: isAllDay,
    href: ev.webLink || null,
  };
}

// graphDateTimeToIso: Graph returns { dateTime: '2026-08-15T14:00:00.0000000',
// timeZone: 'UTC' } (or similar). We pin the result to the supplied
// timeZone by appending a UTC marker; for floating / unspecified zones
// we treat as UTC (lossy but consistent across the grid).
function graphDateTimeToIso(field) {
  if (!field || !field.dateTime) return null;
  const raw = String(field.dateTime);
  // Drop sub-millisecond digits so Date parsing is consistent.
  const trimmed = raw.replace(/(\.\d{3})\d*/, '$1');
  // Graph all-day events arrive as "YYYY-MM-DD" with no time component.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed + 'T00:00:00.000Z';
  }
  // If the timeZone is explicitly UTC, or the dateTime already ends in
  // Z (rare but seen from third-party Graph bridges), normalize by
  // appending Z so `new Date()` parses it as UTC rather than the
  // server's local timezone. Without this, a host in EDT would shift
  // "14:00:00" to "18:00:00Z" and the event would land in the wrong
  // day on the grid.
  if (field.timeZone === 'UTC' || /[Zz]$/.test(trimmed)) {
    const utcish = /[Zz]$/.test(trimmed) ? trimmed : trimmed + 'Z';
    return new Date(utcish).toISOString();
  }
  // Floating local time — store as if UTC (consistent with CalDAV).
  return new Date(trimmed + 'Z').toISOString();
}

module.exports = {
  makeGraphSource,
  mapEvent,
  graphDateTimeToIso,
  tokenIsExpired,
  refreshAccessToken,
  _internals: { defaultHttpDo },
};