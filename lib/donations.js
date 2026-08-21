// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 PHATT Tech LLC

'use strict';

// PHA-2223 policy: this is the one provider Brandon selected, and it is
// deliberately the same link published in the README.  It is not an
// operator setting: a deployment must not quietly turn this into a different
// commercial surface.
const DONATION_URL = 'https://github.com/sponsors/phattbeats';
const DONATION_LABEL = 'Support Homestead';

let db = null;

function migrate(database) {
  db = database;
  // A single row is intentionally less data than an event log.  It can answer
  // only "how many times was the link opened?" -- not when, by whom, or from
  // where.  There are no user, network, browser, provider, or payment fields.
  db.exec(`
    CREATE TABLE IF NOT EXISTS donation_counter (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0)
    );
    INSERT OR IGNORE INTO donation_counter (id, count) VALUES (1, 0);
  `);
}

function getLink() {
  return { url: DONATION_URL, label: DONATION_LABEL };
}

function recordClick() {
  if (!db) return { ok: false, error: 'no_db' };
  try {
    db.prepare('UPDATE donation_counter SET count = count + 1 WHERE id = 1').run();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: 'update_failed' };
  }
}

function getCount() {
  if (!db) return { ok: false, error: 'no_db' };
  try {
    return { ok: true, count: db.prepare('SELECT count FROM donation_counter WHERE id = 1').get().count };
  } catch (error) {
    return { ok: false, error: 'query_failed' };
  }
}

module.exports = { migrate, getLink, recordClick, getCount, DONATION_URL, DONATION_LABEL };
