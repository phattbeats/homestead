// Homestead MCP — iCalendar (RFC 5545) generator for the merged calendar
// resource (`homestead://calendar/merged.ics`, design doc §5.3).
//
// Reuses the escape/format helpers from lib/caldav-source.js so the
// wire shape matches what the rest of the CalDAV stack already emits.
// Adapts `buildVCalendar` (single-event) to a multi-event VCALENDAR.
//
// Input shape: an array of merged events (HTTP `/api/events/merged`
// `events` array items). Output shape: a single RFC 5545 VCALENDAR with
// one VEVENT per input event.

'use strict';

const { buildVCalendar } = require('./caldav-source');

function eventToVEvent(e) {
  // Map the merged-event DTO onto the shape buildVCalendar expects.
  // start/end may be ISO8601 (with time) or YYYY-MM-DD (date-only, all-day).
  // id may be `native-123` or `provider-456` — we strip the prefix so
  // the UIDs are stable across refetches.
  const id = String(e.id || '').replace(/^(native|provider)-/, '');
  const provider = e.origin && e.origin.startsWith('provider:')
    ? e.origin.slice('provider:'.length)
    : 'native';
  const vevent = {
    uid: `${provider}-${id}@homestead.local`,
    title: e.title || '(untitled)',
    description: e.notes || e.description || '',
    location: e.location || '',
    start: e.start || e.date,
    end: e.end || null,
    allDay: !!e.allDay,
    dtstamp: new Date().toISOString(),
    sequence: 0,
  };
  return vevent;
}

// Render a VCALENDAR document containing one VEVENT per input event.
// Always emits CRLF line endings + a trailing CRLF (RFC 5545 §3.1).
function buildMergedVCalendar(events) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Homestead//MCP Merged Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  for (const e of events || []) {
    const single = buildVCalendar(eventToVEvent(e));
    // buildVCalendar includes BEGIN:VCALENDAR / END:VCALENDAR wrapping.
    // For a multi-event calendar we strip the outer wrapper and emit
    // only the inner VEVENT block.
    const inner = single
      .split(/\r?\n/)
      .filter(line => line !== 'BEGIN:VCALENDAR' && line !== 'END:VCALENDAR'
        && !line.startsWith('VERSION:') && !line.startsWith('PRODID:')
        && line !== '');
    lines.push(...inner);
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

module.exports = { buildMergedVCalendar, eventToVEvent };
