// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 PHATT Tech LLC

// Homestead — CalDAV source adapter (PHA-1620).
//
// One implementation, two providers:
//   * Nextcloud (e.g. https://nextcloud.phatt.vip/remote.php/dav)
//   * Apple iCloud (https://caldav.icloud.com)
//
// Both speak CalDAV over HTTPS with HTTP Basic auth (app-password for
// Nextcloud, app-specific-password for iCloud). The shape of the
// calendar-home + REPORT bodies is identical per RFC 4791; the only
// provider-specific knobs are (a) the principal-URL discovery and
// (b) the calendar-home-set path. Both are passed in via the source
// config — see `makeCalDAVSource`.
//
// The HTTP layer is parameterized via the `httpDo` dependency so tests
// can inject canned responses. Production passes `node:https` and
// `node:http` (one each — the source must use https for both
// providers; http is only for the loopback test in
// scripts/test-calendar-sources.js).

'use strict';

const xml2jsLite = (() => {
  // Tiny XML walker — CalDAV responses are small and well-formed, and
  // pulling in a real XML parser dependency for ~10 fields is overkill.
  // Strips XML namespaces (CalDAV: DAV:, CALDAV:, ICAL:) and exposes
  // child elements by local name. Returns the first match for `one` and
  // an array for `all`.
  //
  // Hand-rolled because the alternative (xml2js, fast-xml-parser) is a
  // 50-200KB dep and we need ~150 lines of XML in the entire feature.
  const NS = /<\?xml[^>]*\?>/g;
  const stripNs = (s) => s.replace(/xmlns(?::[a-zA-Z0-9]+)?="[^"]*"/g, '')
    .replace(/<[a-zA-Z0-9]+:/g, '<').replace(/<\/[a-zA-Z0-9]+:/g, '</');
  function parse(xml) {
    xml = String(xml).replace(NS, '').trim();
    xml = stripNs(xml);
    const root = { children: [], text: '' };
    const stack = [root];
    let i = 0;
    while (i < xml.length) {
      if (xml[i] === '<') {
        const end = xml.indexOf('>', i);
        if (end < 0) break;
        const tag = xml.slice(i + 1, end).trim();
        if (tag.startsWith('?') || tag.startsWith('!')) { i = end + 1; continue; }
        if (tag.startsWith('/')) { stack.pop(); i = end + 1; continue; }
        const selfClose = tag.endsWith('/');
        const m = tag.match(/^([^\s\/]+)/);
        if (!m) { i = end + 1; continue; }
        const name = m[1];
        const attrs = {};
        const attrRe = /([a-zA-Z0-9:_-]+)="([^"]*)"/g;
        let am;
        while ((am = attrRe.exec(tag))) attrs[am[1]] = am[2];
        const node = { name, attrs, children: [], text: '' };
        if (selfClose) {
          stack[stack.length - 1].children.push(node);
          i = end + 1;
        } else {
          stack[stack.length - 1].children.push(node);
          stack.push(node);
          i = end + 1;
        }
      } else {
        const next = xml.indexOf('<', i);
        const text = xml.slice(i, next < 0 ? xml.length : next);
        stack[stack.length - 1].text += text;
        i = next < 0 ? xml.length : next;
      }
    }
    return root;
  }
  function find(node, name) {
    const out = [];
    function walk(n) {
      for (const c of n.children) {
        if (c.name === name) out.push(c);
        walk(c);
      }
    }
    walk(node);
    return out;
  }
  function one(node, name) {
    const a = find(node, name);
    return a[0] || null;
  }
  function textOf(node) {
    return (node?.text || '').trim();
  }
  return { parse, find, one, textOf };
})();

// --- HTTP helper ---------------------------------------------------------
// `httpDo` signature: ({ method, url, headers, body }) -> Promise<{ status, headers, body }>
// Implemented in terms of node:https for production; tests inject a stub.

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

// --- Provider quirks -----------------------------------------------------

// iCloud requires a "principal-URL" discovery first. Nextcloud's
// calendar home is predictable from the username.
//
// `principalUrl` is the DAV:href we send PROPFIND against to discover
// the calendar-home-set.
function defaultProviderConfig(provider) {
  if (provider === 'caldav_nextcloud') {
    return {
      // The user gives us the base; the per-user calendar home is
      // <base>/<username>/  (Nextcloud's standard layout).
      discoverPrincipal: false,
    };
  }
  if (provider === 'caldav_icloud') {
    return {
      // iCloud: PROPFIND the user-principal URL to find the
      // calendar-home-set href. The user provides their Apple ID
      // (email) as account_id; the principal URL is derived.
      discoverPrincipal: true,
    };
  }
  throw new Error(`CalDAVSource: unknown provider "${provider}"`);
}

// --- iCalendar (RFC 5545) minimal parser ---------------------------------
// We only need DTSTART/DTEND/SUMMARY/DESCRIPTION/LOCATION/UID for the
// read-through path. Recurrence expansion is deliberately out of scope
// (single VEVENT only, per the work order).

function parseICalDate(s) {
  if (!s) return null;
  // YYYYMMDDTHHMMSSZ or YYYYMMDD or YYYYMMDDTHHMMSS
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', se = '00'] = m;
  const utc = m[7] === 'Z' || (h !== '00' && !s.includes(m[0]));
  // Treat as UTC if Z suffix or has time component (heuristic).
  if (m[7] === 'Z') {
    return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se)).toISOString();
  }
  if (s.includes('T')) {
    // Floating local time — store as if UTC (lossy but consistent).
    return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se)).toISOString();
  }
  // Date-only — anchor at midnight UTC.
  return new Date(Date.UTC(+y, +mo - 1, +d, 0, 0, 0)).toISOString();
}

function parseVEvents(icalText) {
  const events = [];
  // Unfold lines per RFC 5545 (continuation lines start with space/tab).
  const unfolded = String(icalText).replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);
  let inEvent = false;
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === 'BEGIN:VEVENT') { inEvent = true; cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); inEvent = false; cur = null; continue; }
    if (!inEvent || !cur) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const keyPart = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const key = keyPart.split(';')[0]; // drop params (TZID etc.) for now
    if (key === 'UID') cur.uid = value;
    else if (key === 'SUMMARY') cur.title = unescapeIcs(value);
    else if (key === 'DESCRIPTION') cur.description = unescapeIcs(value);
    else if (key === 'LOCATION') cur.location = unescapeIcs(value);
    else if (key === 'DTSTART') cur.start = parseICalDate(value);
    else if (key === 'DTEND') cur.end = parseICalDate(value);
    else if (key === 'DURATION' && cur.start && !cur.end) {
      // Crude DURATION expansion: only handle PT#H and P#D forms.
      const dm = value.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
      if (dm) {
        const [, dd, hh, mm, ss] = dm;
        const start = new Date(cur.start);
        if (dd) start.setUTCDate(start.getUTCDate() + +dd);
        if (hh) start.setUTCHours(start.getUTCHours() + +hh);
        if (mm) start.setUTCMinutes(start.getUTCMinutes() + +mm);
        if (ss) start.setUTCSeconds(start.getUTCSeconds() + +ss);
        cur.end = start.toISOString();
      }
    }
  }
  return events;
}

function unescapeIcs(s) {
  return String(s).replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\\\/g, '\\').replace(/\\;/g, ';');
}

// --- iCalendar (RFC 5545) minimal serializer -----------------------------
// Inverse of parseVEvents. Emits a single-VCALENDAR document containing
// one VEVENT. Phase 2 write-back only — no recurrence expansion (work
// order: "single VEVENT only"; PHA-1620 step 4). Fields omitted in the
// input are omitted from the output (no empty SUMMARY/Description lines).
//
// `vevent` shape (matches parseVEvents's output):
//   {
//     uid?: string,            // defaults to a generated UUID-ish
//     title?: string,
//     description?: string,
//     location?: string,
//     start: ISO 8601 string,  // required
//     end?: ISO 8601 string,   // optional; date-only if end === start date
//     allDay?: boolean,        // when true, emit VALUE=DATE (no time)
//     dtstamp?: ISO 8601 string, // defaults to now
//     sequence?: number,       // for updates; defaults to 0
//   }

function buildVCalendar(vevent) {
  if (!vevent || !vevent.start) throw new Error('buildVCalendar: vevent.start is required');
  const esc = (s) => String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\n|\r/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
  const isDateOnly = !!vevent.allDay || (typeof vevent.start === 'string' && vevent.start.length === 10);
  const dtStart = isDateOnly
    ? `DTSTART;VALUE=DATE:${formatIcsDateOnly(vevent.start)}`
    : `DTSTART:${formatIcsDate(vevent.start)}`;
  const lines = [];
  if (vevent.end) {
    const isEndDateOnly = isDateOnly || (typeof vevent.end === 'string' && vevent.end.length === 10);
    lines.push(isEndDateOnly
      ? `DTEND;VALUE=DATE:${formatIcsDateOnly(vevent.end)}`
      : `DTEND:${formatIcsDate(vevent.end)}`);
  } else if (!isDateOnly) {
    // Default end: 1 hour after start. RFC 5545 requires DTEND or
    // DURATION on a VEVENT — the HTTP route guards UX, but the
    // serializer is the last line of defence.
    const s = new Date(vevent.start);
    const e = new Date(s.getTime() + 60 * 60 * 1000);
    lines.push(`DTEND:${formatIcsDate(e.toISOString())}`);
  }
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Homestead//CalDAV//EN',
    'BEGIN:VEVENT',
    `UID:${vevent.uid || generateUid()}`,
    `DTSTAMP:${formatIcsDate(vevent.dtstamp || new Date().toISOString())}`,
    `SEQUENCE:${vevent.sequence || 0}`,
    dtStart,
    ...lines,
    vevent.title ? `SUMMARY:${esc(vevent.title)}` : null,
    vevent.description ? `DESCRIPTION:${esc(vevent.description)}` : null,
    vevent.location ? `LOCATION:${esc(vevent.location)}` : null,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).join('\r\n') + '\r\n';
}

function generateUid() {
  // RFC 4122-shaped v4 UUID without the external dep. Good enough as a
  // unique-enough local-id; the server isn't the source of truth so a
  // collision only matters if the iCloud provider hands back two
  // different events with the same UID — vanishingly rare.
  const rand = () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `${rand()}${rand()}-${rand()}-4${rand().slice(1)}-${rand()}-${rand()}${rand()}${rand()}`;
}

function formatIcsDateOnly(iso) {
  // ISO date-only (YYYY-MM-DD) -> YYYYMMDD for VALUE=DATE DTSTART/DTEND.
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw new Error('formatIcsDateOnly: bad date-only ISO: ' + iso);
  return m[1] + m[2] + m[3];
}

// --- URL helpers ---------------------------------------------------------
// CalDAV hrefs come back as either absolute URLs (Nextcloud) or relative
// paths (iCloud). Combining the calendar's href with the per-event UID
// requires being explicit about which is which.

function resolveEventUrl(calendarHref, externalId, baseUrl) {
  if (!calendarHref) throw new Error('resolveEventUrl: calendarHref is required');
  if (!externalId) throw new Error('resolveEventUrl: externalId is required');
  // If externalId is already a URL (e.g. pulled from a cached .ics href),
  // use it as-is. This is the common case for deleteEvent after a
  // listEvents — the href arrives verbatim and we don't want to re-stitch.
  if (/^https?:\/\//i.test(externalId)) return externalId;
  // If calendarHref is absolute, slap the UID+.ics onto the end (most
  // CalDAV servers expect the .ics suffix on resources).
  if (/^https?:\/\//i.test(calendarHref)) {
    return calendarHref.replace(/\/?$/, '/') + encodeURIComponent(externalId) + '.ics';
  }
  // Both are relative — combine against baseUrl.
  if (!baseUrl) throw new Error('resolveEventUrl: relative calendarHref requires baseUrl');
  return baseUrl.replace(/\/?$/, '/') + calendarHref.replace(/^\//, '') + encodeURIComponent(externalId) + '.ics';
}

// --- Adapter factory -----------------------------------------------------
//
// `config` is the calendar_sources row's "creds + endpoint" payload
//   * provider: 'caldav_nextcloud' | 'caldav_icloud'
//   * account_id: Nextcloud username / iCloud Apple ID
//   * base_url: provider's CalDAV root
//   * app_password: plaintext (caller decrypts via secret-box first)
//
// Returns an object with listCalendars(), listEvents(range), and the
// Phase 2 write methods (createEvent, updateEvent, deleteEvent). The
// write methods are HTTP thin wrappers — the VCALENDAR document is
// built by buildVCalendar() so the same serializer is shared by create
// and update.
function makeCalDAVSource(config, deps = {}) {
  if (!config || !config.provider || !config.account_id || !config.base_url) {
    throw new Error('CalDAVSource: config requires provider, account_id, base_url');
  }
  if (!config.app_password) {
    throw new Error('CalDAVSource: config.app_password is required');
  }
  const httpDo = deps.httpDo || defaultHttpDo;
  const providerCfg = defaultProviderConfig(config.provider);
  const auth = 'Basic ' + Buffer.from(`${config.account_id}:${config.app_password}`).toString('base64');

  async function findCalendarHomeHref() {
    if (providerCfg.discoverPrincipal) {
      // iCloud principal URL is documented as
      // https://caldav.icloud.com/<principal-hash>/  — typically the
      // Apple ID URL-encoded. We probe it; if that fails, try a
      // user-principal-URL PROPFIND against the base.
      const candidate = config.base_url.replace(/\/$/, '') + '/' + encodeURIComponent(config.account_id) + '/';
      const r = await httpDo({
        method: 'PROPFIND',
        url: candidate,
        headers: {
          Authorization: auth,
          Depth: '0',
          'Content-Type': 'application/xml; charset=utf-8',
        },
        body: '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><calendar-home-set xmlns="urn:ietf:params:xml:ns:caldav"/></prop></propfind>',
      });
      if (r.status >= 200 && r.status < 300) {
        const tree = xml2jsLite.parse(r.body);
        const href = xml2jsLite.find(tree, 'href').map(n => n.text.trim()).filter(Boolean);
        if (href[0]) return href[0];
      }
      throw new Error('CalDAVSource: iCloud principal discovery failed (status ' + r.status + ')');
    }
    // Nextcloud: calendar home is <base>/<username>/
    return config.base_url.replace(/\/$/, '') + '/' + encodeURIComponent(config.account_id) + '/';
  }

  async function listCalendars() {
    const home = await findCalendarHomeHref();
    const r = await httpDo({
      method: 'PROPFIND',
      url: home,
      headers: {
        Authorization: auth,
        Depth: '1',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body: '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><prop><resourcetype/><displayname xmlns="DAV:"/><calendar-color xmlns="http://apple.com/ns/ical/"/><calendar-description xmlns="urn:ietf:params:xml:ns:caldav"/></prop></propfind>',
    });
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`CalDAVSource: PROPFIND failed (status ${r.status})`);
    }
    const tree = xml2jsLite.parse(r.body);
    const responses = xml2jsLite.find(tree, 'response');
    const out = [];
    for (const resp of responses) {
      const href = (xml2jsLite.one(resp, 'href')?.text || '').trim();
      const rt = xml2jsLite.one(resp, 'resourcetype');
      const isCal = rt && xml2jsLite.find(rt, 'calendar').length > 0;
      if (!isCal) continue;
      const display = xml2jsLite.textOf(xml2jsLite.one(resp, 'displayname')) || href.split('/').filter(Boolean).pop();
      out.push({
        href,
        displayName: display,
      });
    }
    return out;
  }

  async function listEvents({ start, end, calendarHref } = {}) {
    if (!calendarHref) throw new Error('listEvents: calendarHref is required');
    if (!start || !end) throw new Error('listEvents: start and end (ISO 8601) are required');
    const range = `start="${formatIcsDate(start)}" end="${formatIcsDate(end)}"`;
    const r = await httpDo({
      method: 'REPORT',
      url: calendarHref,
      headers: {
        Authorization: auth,
        Depth: '1',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body:
        '<?xml version="1.0" encoding="utf-8"?>' +
        '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
        '<D:prop><D:getetag/><C:calendar-data/></D:prop>' +
        `<C:time-range ${range}/>` +
        '</C:calendar-query>',
    });
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`CalDAVSource: REPORT failed (status ${r.status})`);
    }
    const tree = xml2jsLite.parse(r.body);
    const responses = xml2jsLite.find(tree, 'response');
    const events = [];
    for (const resp of responses) {
      const href = (xml2jsLite.one(resp, 'href')?.text || '').trim();
      const etag = (xml2jsLite.one(resp, 'getetag')?.text || '').trim();
      const cal = xml2jsLite.textOf(xml2jsLite.one(resp, 'calendar-data'));
      if (!cal) continue;
      const vevents = parseVEvents(cal);
      for (const v of vevents) {
        if (!v.start) continue;
        events.push({
          externalId: v.uid || href,
          etag,
          title: v.title || '(untitled)',
          description: v.description || '',
          location: v.location || '',
          start: v.start,
          end: v.end || null,
          allDay: !v.end || v.end.length === 10,
          href,
        });
      }
    }
    return events;
  }

  // --- Phase 2 write-back (PHA-1866) --------------------------------------
  // CalDAV write-back is a thin HTTP wrapper around RFC 5546 + 4791:
  //   * create  -> PUT /<cal-href>/<uid>.ics   with If-None-Match: *
  //   * update  -> PUT /<cal-href>/<uid>.ics   with If-Match: <etag>
  //   * delete  -> DELETE /<cal-href>/<uid>.ics (If-Match optional)
  //
  // The HTTP-only transport means there is no business logic here
  // beyond validation and URL composition — every secret (the
  // app_password) stays inside the CalDAVSource closure and never
  // leaks into the request body or URL.

  function validateVevent(vevent) {
    if (!vevent || typeof vevent !== 'object') throw new Error('validateVevent: vevent object required');
    if (!vevent.start) throw new Error('validateVevent: vevent.start is required');
    // Loosely verify start is parseable — full validation lives in the
    // format helpers (they throw on bad input).
    new Date(vevent.start).toISOString();
  }

  async function createEvent({ calendarHref, vevent, externalId, etag } = {}) {
    if (!calendarHref) throw new Error('createEvent: calendarHref is required');
    validateVevent(vevent);
    // Allow the caller to provide a UID (for idempotent retries) or let
    // us generate one. The PUT URL is derived from the final UID.
    const uid = externalId || vevent.uid || generateUid();
    const url = resolveEventUrl(calendarHref, uid, config.base_url);
    const body = buildVCalendar({ ...vevent, uid });
    const headers = {
      Authorization: auth,
      'Content-Type': 'text/calendar; charset=utf-8',
      // If-None-Match: * ensures we never overwrite an existing
      // resource at the same URL — important when the caller
      // retries a failed create with a fresh UID.
      'If-None-Match': '*',
    };
    const r = await httpDo({ method: 'PUT', url, headers, body });
    if (r.status < 200 || r.status >= 300) {
      const msg = String(r.body || '').slice(0, 256);
      throw new Error(`CalDAVSource.createEvent: PUT failed (status ${r.status}): ${msg}`);
    }
    const newEtag = (r.headers && (r.headers.etag || r.headers.ETag)) || '';
    return { externalId: uid, href: url, etag: newEtag };
  }

  async function updateEvent({ calendarHref, externalId, vevent, etag } = {}) {
    if (!calendarHref) throw new Error('updateEvent: calendarHref is required');
    if (!externalId) throw new Error('updateEvent: externalId is required');
    validateVevent(vevent);
    const url = resolveEventUrl(calendarHref, externalId, config.base_url);
    const body = buildVCalendar({ ...vevent, uid: externalId });
    const headers = {
      Authorization: auth,
      'Content-Type': 'text/calendar; charset=utf-8',
    };
    // If-Match: <etag> protects against lost-update: a concurrent edit
    // elsewhere will have produced a new etag, and the PUT will fail
    // with 412 so the caller can re-fetch and retry.
    if (etag) headers['If-Match'] = etag;
    const r = await httpDo({ method: 'PUT', url, headers, body });
    if (r.status < 200 || r.status >= 300) {
      const msg = String(r.body || '').slice(0, 256);
      throw new Error(`CalDAVSource.updateEvent: PUT failed (status ${r.status}): ${msg}`);
    }
    const newEtag = (r.headers && (r.headers.etag || r.headers.ETag)) || '';
    return { externalId, href: url, etag: newEtag };
  }

  async function deleteEvent({ calendarHref, externalId, etag } = {}) {
    if (!calendarHref) throw new Error('deleteEvent: calendarHref is required');
    if (!externalId) throw new Error('deleteEvent: externalId is required');
    const url = resolveEventUrl(calendarHref, externalId, config.base_url);
    const headers = { Authorization: auth };
    if (etag) headers['If-Match'] = etag;
    const r = await httpDo({ method: 'DELETE', url, headers });
    // 204 No Content is the standard success; 200 OK is also accepted
    // by some servers (Nextcloud returns 204, iCloud returns 200).
    if (r.status < 200 || r.status >= 300) {
      const msg = String(r.body || '').slice(0, 256);
      throw new Error(`CalDAVSource.deleteEvent: DELETE failed (status ${r.status}): ${msg}`);
    }
    return { externalId, href: url, ok: true };
  }

  return {
    kind: 'caldav',
    provider: config.provider,
    listCalendars,
    listEvents,
    createEvent,
    updateEvent,
    deleteEvent,
  };
}

function formatIcsDate(iso) {
  // Convert ISO 8601 -> YYYYMMDDTHHMMSSZ for CalDAV time-range.
  const d = new Date(iso);
  if (isNaN(d.getTime())) throw new Error('formatIcsDate: bad ISO: ' + iso);
  return d.getUTCFullYear().toString().padStart(4, '0') +
    (d.getUTCMonth() + 1).toString().padStart(2, '0') +
    d.getUTCDate().toString().padStart(2, '0') + 'T' +
    d.getUTCHours().toString().padStart(2, '0') +
    d.getUTCMinutes().toString().padStart(2, '0') +
    d.getUTCSeconds().toString().padStart(2, '0') + 'Z';
}

module.exports = {
  makeCalDAVSource,
  parseVEvents,
  parseICalDate,
  buildVCalendar,
  resolveEventUrl,
  _internals: { xml2jsLite, formatIcsDate, formatIcsDateOnly, defaultHttpDo },
};
