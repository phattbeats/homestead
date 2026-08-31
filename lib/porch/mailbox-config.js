// Agent-to-agent mailbox config (PHA-2426). Same env-override shape as
// lib/porch/sweep-config.js. Pure data — no DB, no express. Imported by
// lib/porch/mailbox.js and its tests.

'use strict';

const { envInt } = require('./sweep-config');

const DEFAULTS = {
  // Chatter budget, rule 2 of the PHA-1617 non-negotiables: caps how
  // many messages one installed foreign-agent app can post across ALL
  // its threads within a rolling window — approximates "per heartbeat"
  // without coupling this module to whatever cadence a given external
  // harness actually polls on.
  MAX_MESSAGES_PER_WINDOW: envInt('MAILBOX_MAX_MESSAGES_PER_WINDOW', 5),
  WINDOW_MINUTES: envInt('MAILBOX_WINDOW_MINUTES', 60),
  // Per-thread turn limit (same rule): total messages (either
  // direction) a single thread may accumulate before it's closed to
  // new turns. A stalled negotiation should end, not loop forever.
  MAX_TURNS_PER_THREAD: envInt('MAILBOX_MAX_TURNS_PER_THREAD', 20),
};

module.exports = { DEFAULTS };
