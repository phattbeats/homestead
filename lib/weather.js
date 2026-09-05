// lib/weather.js
//
// PHA-2853 — typed weather entry for the Gazette masthead.
//
// STUB / MOCK PROVIDER. No real weather integration exists anywhere in
// this repo (grepped before writing this file). Rather than block the
// Gazette rework on standing up a real forecast API + API key + secret
// storage, this returns a plausible TYPED shape from a deterministic
// pseudo-random generator seeded by date, so the masthead has something
// real to render and the shape is stable for tests/snapshots. Swapping
// in a real provider later is a one-function change: replace `today()`
// below with a fetch, keep the same return shape.
'use strict';

const ICONS = ['sun', 'cloud-sun', 'cloud', 'cloud-rain', 'cloud-drizzle', 'wind', 'snow'];
const SUMMARIES = {
  sun: 'Clear and bright',
  'cloud-sun': 'Partly cloudy',
  cloud: 'Overcast',
  'cloud-rain': 'Rain likely',
  'cloud-drizzle': 'Light drizzle',
  wind: 'Breezy',
  snow: 'Snow showers',
};

// Simple deterministic hash so the same date always yields the same
// mock weather (stable across cron + on-demand generation + tests).
function seedFor(dateStr) {
  let h = 0;
  for (let i = 0; i < dateStr.length; i++) {
    h = (h * 31 + dateStr.charCodeAt(i)) >>> 0;
  }
  return h;
}

// `today(dateStr)` -> typed weather entry for the masthead.
//   { icon, summary, temp_f, temp_c, source }
// `source: 'mock'` marks this as the stub so a future real integration
// is easy to grep for and callers can choose to badge it if desired.
function today(dateStr) {
  const seed = seedFor(dateStr || new Date().toISOString().slice(0, 10));
  const icon = ICONS[seed % ICONS.length];
  const temp_f = 45 + (seed % 40); // 45-84F, plausible year-round range
  return {
    icon,
    summary: SUMMARIES[icon],
    temp_f,
    temp_c: Math.round(((temp_f - 32) * 5) / 9),
    source: 'mock',
  };
}

module.exports = { today };
