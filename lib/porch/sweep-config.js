// Porch sweep scheduler config (PHA-2646).
//
// Every knob from the issue's "Mechanics" list, with an env override so
// ops can tune cadence/budget without a redeploy. Pure data — no DB,
// no express. Imported by lib/porch/sweep.js and its tests.

'use strict';

function envInt(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : def;
}

const DEFAULTS = {
  // How often the scheduler is willing to re-sweep a given wall.
  SWEEP_INTERVAL_MINUTES: envInt('PORCH_SWEEP_INTERVAL_MINUTES', 90),
  // A post younger than this never gets an agent decision — humans get
  // first shot at it.
  GRACE_WINDOW_HOURS: envInt('PORCH_GRACE_WINDOW_HOURS', 4),
  // Per agent, per wall, per wall-local day. The exact number an agent
  // gets on a given day is drawn once from [MIN, MAX] (see
  // effectiveDailyBudget in sweep.js) so it isn't the same round number
  // every day.
  DAILY_BUDGET_MIN: envInt('PORCH_DAILY_BUDGET_MIN', 3),
  DAILY_BUDGET_MAX: envInt('PORCH_DAILY_BUDGET_MAX', 4),
  // Once any agent has acted on a post by this author (in this wall),
  // no agent may act on another post by the same author until this
  // many hours have passed.
  AUTHOR_COOLDOWN_HOURS: envInt('PORCH_AUTHOR_COOLDOWN_HOURS', 6),
  // Reaction time is drawn from Uniform(0, JITTER_MAX_MINUTES) after a
  // sweep picks a post up.
  JITTER_MAX_MINUTES: envInt('PORCH_JITTER_MAX_MINUTES', 60),
  // Minutes east of UTC used to compute "wall-local midnight" for the
  // daily budget reset. Walls don't carry their own timezone column
  // (v1), so this is a single household-wide offset.
  TIMEZONE_OFFSET_MINUTES: envInt('PORCH_TIMEZONE_OFFSET_MINUTES', 0),
  // Meta-tick: how often the background timer checks whether any wall
  // is due for a sweep. Independent of SWEEP_INTERVAL_MINUTES so the
  // per-wall cadence stays accurate without a matching-size timer.
  TICK_INTERVAL_MINUTES: envInt('PORCH_TICK_INTERVAL_MINUTES', 5),
};

module.exports = { DEFAULTS, envInt };
