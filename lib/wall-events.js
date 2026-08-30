'use strict';

// PHA-2821: in-process pub/sub so a new wall post reaches every member
// who has that wall open right now, without a second realtime transport.
// PHA-1899's drawer SSE is one-shot request/response (dispatch a message,
// stream the reply, close); this is a long-lived per-wall broadcast, so
// it gets its own small EventEmitter keyed by wall slug rather than
// bolting broadcast semantics onto the drawer dispatcher.
//
// In-memory only — single-process assumption already holds for this app
// (better-sqlite3 is a single-file, single-process store). A multi-process
// deploy would need this backed by something shared (Redis pub/sub, etc.);
// out of scope until Homestead actually runs more than one process.

const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(0);

function publish(slug, event, data) {
  bus.emit(slug, { event, data });
}

// subscribe(slug, handler) -> unsubscribe()
function subscribe(slug, handler) {
  bus.on(slug, handler);
  return () => bus.off(slug, handler);
}

module.exports = { publish, subscribe };
