// Homestead — Google Calendar source adapter (PHA-1865 / PHA-1620b).
//
// First-cut adapter behind the same CalendarSource contract as the
// CalDAV and Microsoft Graph adapters (see lib/calendar-sources.js).
// Talks to Google Calendar API v3 at
// https://www.googleapis.com/calendar/v3/ using an OAuth2 access
// token + refresh token supplied by the per-user calendar_sources
// row's encrypted cred_blob.
//
// Endpoints used (read path — Phase 2 will add write-back):
//   GET /users/me/calendarList                       — list calendars
//   GET /calendars/{calendarId}/events               — window-bounded
//                                                     event list with
//                                                     timeMin / timeMax
//                                                     and singleEvents=true
//                                                     so recurring
//                                                     events are
//                                                     expanded server-side
//   POST https://oauth2.googleapis.com/token         — refresh-token
//                                                     grant, used when
//                                                     the stored
//                                                     access_token is
//                                                     past `expires_at`
//
// The HTTP layer is parameterized via the `httpDo` dependency so
// tests can inject canned responses (no real Google calls in CI).
// Production passes a tiny https-backed helper that mirrors the
// CalDAV/Graph adapters' defaultHttpDo.
//
// Credentials shape (the JSON we encrypt into cred_blob):
//   {
//     access_token:  '<opaque oauth2 token>',
//     refresh_token: '<opaque refresh>',
//     expires_at:    '2026-08-09T20:00:00.000Z' | null,
//     client_id:     '<google-oauth-client-id>'   | null,
//     client_secret: '<google-oauth-client-secret>' | null,
//     scope:         'https://www.googleapis.com/auth/calendar.readonly' | null,
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
  // refresh attempt rather than a guaranteed 401 round-trip. Google
  // tokens are nominally 1h but the refresh round-trip is sub-second;
  // the buffer just protects against clock skew across nodes.
  return now.getTime() >= (t - 60_000);
}

// refreshAccessToken(tokenState, httpDo) exchanges the refresh_token
// for a fresh access_token via Google's OAuth2 token endpoint. Returns
// a NEW tokenState object — the caller is responsible for re-encrypting
// it back into cred_blob (calendar-sources.js owns that flow).
//
// Required config: client_id, refresh_token (and optionally
// client_secret for confidential clients). If any required field is
// missing, throws — better to surface the misconfiguration than to
// ship a perpetually-broken adapter.
//
// Google's OAuth2 client_secret requirement depends on the app type:
//   - Web apps (Confidential): client_id + client_secret required
//   - Installed/Mobile/Desktop apps (Public): client_secret optional;
//     PKCE protects the auth-code flow, refresh tokens are long-lived
// For v1 we accept either shape and only send client_secret when
// present — same pattern the Graph adapter uses for scope.
async function refreshAccessToken(tokenState, httpDo = defaultHttpDo, tokenEndpoint) {
  if (!tokenState) throw new Error('refreshAccessToken: tokenState is required');
  const { refresh_token, client_id, client_secret, scope } = tokenState;
  if (!refresh_token) throw new Error('refreshAccessToken: refresh_token is required');
  if (!client_id) throw new Error('refreshAccessToken: client_id is required (set during source creation)');
  const endpoint = tokenEndpoint || 'https://oauth2.googleapis.com/token';
  const form = new URLSearchParams({
    client_id,
    grant_type: 'refresh_token',
    refresh_token,
  });
  if (client_secret) form.set('client_secret', client_secret);
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
    throw new Error(`GoogleSource: token refresh failed (status ${r.status})`);
  }
  let parsed;
  try { parsed = JSON.parse(r.body); }
  catch (e) {
    throw new Error('GoogleSource: token refresh returned non-JSON: ' + e.message);
  }
  if (!parsed.access_token) {
    throw new Error('GoogleSource: token refresh response missing access_token');
  }
  // Google access tokens are nominally 3600s; respect what the server
  // tells us but cap at 1h if it over-reports.
  const expiresIn = Math.min(Number(parsed.expires_in || 3600), 3600);
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  return {
    access_token: parsed.access_token,
    refresh_token: parsed.refresh_token || refresh_token,
    expires_at: expiresAt,
    client_id,
    client_secret: client_secret || null,
    scope,
  };
}

// --- Adapter factory ----------------------------------------------------
//
// `config` is the calendar_sources row's "creds + endpoint" payload
//   * provider:    'google'
//   * account_id:  the user's Google account email (informational;
//                  Google uses the /users/me/* paths that auto-resolve
//                  to whichever account the OAuth token was issued for)
//   * base_url:    optional override for Google Calendar base (default
//                  https://www.googleapis.com/calendar/v3)
//   * access_token, refresh_token, expires_at, client_id, client_secret,
//     scope (all required for the refresh path; tests stub httpDo
//     and inject a never-expiring token to skip it)
//
// Returns an object with listCalendars() and listEvents(range) plus
// Phase-2 write stubs that throw "not implemented" — same shape as
// CalDAVSource/GraphSource so the merge layer doesn't care which
// adapter produced the events.
function makeGoogleSource(config, deps = {}) {
  if (!config || !config.provider) {
    throw new Error('GoogleSource: config.provider is required');
  }
  if (config.provider !== 'google') {
    throw new Error(`GoogleSource: unknown provider "${config.provider}"`);
  }
  if (!config.access_token) {
    throw new Error('GoogleSource: config.access_token is required');
  }
  const httpDo = deps.httpDo || defaultHttpDo;
  const baseUrl = (config.base_url || 'https://www.googleapis.com/calendar/v3').replace(/\/$/, '');
  const tokenState = {
    access_token: config.access_token,
    refresh_token: config.refresh_token || null,
    expires_at: config.expires_at || null,
    client_id: config.client_id || null,
    client_secret: config.client_secret || null,
    scope: config.scope || null,
  };
  const tokenEndpoint = deps.tokenEndpoint || null;
  // onTokenRefresh is an optional hook so calendar-sources.js can
  // re-encrypt and persist a rotated token without coupling this
  // module to the database layer. Tests pass a spy.
  const onTokenRefresh = deps.onTokenRefresh || (async () => {});

  // googleFetch wraps httpDo with bearer auth + automatic refresh.
  // Mirrors the Graph adapter's `graphFetch` shape so the refresh
  // contract is consistent across OAuth2 providers.
  async function googleFetch(method, path, { body, headers, query } = {}) {
    if (tokenIsExpired(tokenState)) {
      if (tokenState.refresh_token && tokenState.client_id) {
        const fresh = await refreshAccessToken(tokenState, httpDo, tokenEndpoint);
        Object.assign(tokenState, fresh);
        await onTokenRefresh(fresh);
      } else {
        throw new Error('GoogleSource: access_token expired and no refresh_token available');
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
    const r = await googleFetch('GET', '/users/me/calendarList');
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`GoogleSource: GET /users/me/calendarList failed (status ${r.status})`);
    }
    let parsed;
    try { parsed = JSON.parse(r.body); }
    catch (e) { throw new Error('GoogleSource: /users/me/calendarList returned non-JSON: ' + e.message); }
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    return items.map((c) => ({
      id: c.id,
      // Google "calendar id" is an email-like string ('primary' or
      // 'brandon@phatt.tech'); it's the calendarHref form we store
      // verbatim in calendar_sources.calendar_id.
      href: c.id,
      displayName: c.summary || c.summaryOverride || c.id,
      color: c.backgroundColor || null,
      canEdit: c.accessRole === 'writer' || c.accessRole === 'owner',
      isDefault: !!c.primary,
    }));
  }

  async function listEvents({ start, end, calendarHref } = {}) {
    if (!start || !end) throw new Error('listEvents: start and end (ISO 8601) are required');
    // calendarHref is the Google calendar id (e.g. 'primary' or
    // 'brandon@phatt.tech'). When absent we fall through to the user's
    // primary calendar via the /calendars/{primary}/events endpoint.
    const cid = calendarHref || 'primary';
    const events = [];
    let pageToken = null;
    let pageCount = 0;
    do {
      const query = {
        timeMin: start,
        timeMax: end,
        // singleEvents=true expands recurring events into individual
        // instances server-side; without this we get one row per
        // recurrence rule and have to expand client-side (not
        // implemented in this first-cut).
        singleEvents: 'true',
        // orderBy=startTime is only valid with singleEvents=true.
        orderBy: 'startTime',
        maxResults: '2500',
      };
      if (pageToken) query.pageToken = pageToken;
      const r = await googleFetch('GET', `/calendars/${encodeURIComponent(cid)}/events`, { query });
      if (r.status < 200 || r.status >= 300) {
        throw new Error(`GoogleSource: events list failed (status ${r.status})`);
      }
      let parsed;
      try { parsed = JSON.parse(r.body); }
      catch (e) { throw new Error('GoogleSource: events list returned non-JSON: ' + e.message); }
      const items = Array.isArray(parsed.items) ? parsed.items : [];
      for (const ev of items) events.push(mapEvent(ev));
      pageToken = parsed.nextPageToken || null;
      pageCount++;
      // Safety brake — the month-grid path should never paginate more
      // than a handful of times. With maxResults=2500 a single page
      // covers a normal user for months; if we're spinning, fail loudly
      // so the sync orchestrator can mark the source stale instead of
      // hanging.
      if (pageCount > 20) {
        throw new Error('GoogleSource: events list exceeded 20 pages, aborting');
      }
    } while (pageToken);
    return events;
  }

  return {
    kind: 'google',
    provider: config.provider,
    account_id: config.account_id || null,
    // listCalendars is implemented but not currently exercised by the
    // PHA-1620 read-through path (which is wired to a pre-configured
    // calendar_id). Kept on the interface so the Phase-2 setup UI can
    // discover Google calendars the same way it will discover CalDAV/Graph.
    listCalendars,
    listEvents,
    // Phase 2 stubs (not implemented in this first-cut):
    createEvent: async () => { throw new Error('GoogleSource.createEvent: Phase 2, not implemented'); },
    updateEvent: async () => { throw new Error('GoogleSource.updateEvent: Phase 2, not implemented'); },
    deleteEvent: async () => { throw new Error('GoogleSource.deleteEvent: Phase 2, not implemented'); },
  };
}

// mapEvent converts a Google Calendar API event payload into the shape
// calendar-sources.syncSource() expects:
//   { externalId, title, description, start, end, allDay, location, href, etag }
// All fields are strings or nulls — no Date objects, no provider
// enums. Google's start.dateTime is RFC 3339 with offset (e.g.
// "2026-08-15T14:00:00-04:00"), and all-day events use start.date
// instead. We normalize both into UTC ISO strings so the merge layer
// treats all providers the same.
function mapEvent(ev) {
  const start = googleDateTimeToIso(ev.start);
  const end = googleDateTimeToIso(ev.end);
  // Google's all-day events have NO start.dateTime — only start.date.
  // We detect this by the absence of dateTime; the presence of date
  // alone marks an all-day event.
  const isAllDay = !!(ev.start && ev.start.date && !ev.start.dateTime);
  return {
    externalId: ev.id || null,
    etag: ev.etag || null,
    title: ev.summary || '(untitled)',
    description: ev.description || '',
    location: ev.location || '',
    start,
    end,
    allDay: isAllDay,
    href: ev.htmlLink || null,
  };
}

// googleDateTimeToIso: Google Calendar returns either
//   { dateTime: '2026-08-15T14:00:00-04:00', timeZone: 'America/New_York' }
// (timed events) or
//   { date: '2026-08-20' }
// (all-day events). We normalize both into UTC ISO strings.
//
// For timed events we let `new Date()` parse the RFC 3339 string and
// emit the .toISOString() form — the offset is preserved through
// Date parsing so a 14:00 EDT event correctly lands at 18:00 UTC.
//
// For all-day events Google's `end.date` is EXCLUSIVE (the day AFTER
// the last day of the event — Google follows the iCalendar spec for
// all-day end dates). We return the raw date string with a T00:00:00Z
// marker so the merge layer's overlap math is consistent; the
// exclusive-day semantics for end is a documented quirk we accept
// here. (The CalDAV adapter already does the same thing for VEVENT
// DTEND-exclusive dates.)
function googleDateTimeToIso(field) {
  if (!field) return null;
  // All-day form: { date: 'YYYY-MM-DD' }.
  if (field.date) {
    const d = String(field.date);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      return d + 'T00:00:00.000Z';
    }
    return null;
  }
  // Timed form: { dateTime: RFC 3339 }.
  if (field.dateTime) {
    const raw = String(field.dateTime);
    const t = new Date(raw);
    if (isNaN(t.getTime())) return null;
    return t.toISOString();
  }
  return null;
}

module.exports = {
  makeGoogleSource,
  mapEvent,
  googleDateTimeToIso,
  tokenIsExpired,
  refreshAccessToken,
  _internals: { defaultHttpDo },
};