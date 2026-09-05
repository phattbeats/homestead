#!/usr/bin/env node
// PHA-2853 — seed 28 back-issues of `gazette_issues` for a demo/test
// user, so the standalone Gazette page has real scrollback on first
// paint instead of a blank "no back-issues yet" state.
//
// Direct DB write only (mirrors scripts/seed-dune.js's convention):
// idempotent via `gazette.putIssue`'s upsert, safe to re-run.
//
// Usage: node scripts/seed-gazette-issues.js [username]
//   Defaults to 'brandon'. DATA_DIR env var picks the DB, same as the
//   server and other seed scripts.

'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const dbPath = path.join(DATA_DIR, 'life.db');

const userModel = require('../lib/user-model');
const gazette = require('../lib/gazette');
const weather = require('../lib/weather');

const username = process.argv[2] || 'brandon';
const ISSUE_COUNT = 28;

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function main() {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  userModel.migrate(db);
  gazette.migrate(db);

  const me = userModel.getMe(db, username);
  if (!me) {
    console.error(`seed-gazette-issues: no such user '${username}' — run the server once first so it provisions.`);
    process.exit(1);
  }

  const today = new Date();
  let written = 0;

  // Deterministic-but-varied sample material so back-issues don't all
  // look identical. Real production issues come from
  // gazette.composeTypedPayload() against live context; this seed
  // fabricates a comparable typed shape directly since there's no
  // live tasks/wall/calendar history to replay 28 days back.
  for (let i = ISSUE_COUNT; i >= 1; i--) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    const date = isoDate(d);
    const quiet = i % 6 === 0; // every 6th day prints thin, per the thin-edition rule

    const sections = quiet ? [] : [
      {
        key: 'rotation_desk',
        title: 'Rotation Desk',
        headline: 'Whose turn it is today',
        body: `Day ${ISSUE_COUNT - i + 1} of the rotation kept moving.`,
        items: [
          { type: 'task', id: `seed-task-${i}-1`, title: 'Take out recycling', assignee: 'brandon', due_date: date, status: 'due_today' },
          { type: 'task', id: `seed-task-${i}-2`, title: 'Water the porch plants', assignee: 'emily', due_date: date, status: 'due_soon' },
        ],
      },
      {
        key: 'arts_media',
        title: 'Arts & Media',
        items: i % 3 === 0 ? [
          { type: 'arrival', id: `seed-arr-${i}`, kind: 'movie', name: `Sample Feature ${i}`, source_service: 'plex', created_at: date },
        ] : [],
      },
      {
        key: 'porch',
        title: 'From the Porch',
        items: i % 2 === 0 ? [
          { type: 'post', id: `seed-post-${i}`, wall_slug: 'household', wall_name: 'Household', author_display: 'Emily', text_body: 'Dinner was great tonight.', created_at: date },
        ] : [],
      },
      {
        key: 'listings',
        title: "Today's Listings",
        items: [
          { type: 'event', id: `seed-evt-${i}`, title: 'Family dinner', time: '18:00', room_id: null, room_label: i % 4 === 0 ? 'Kitchen' : null },
        ],
      },
    ].filter(s => s.items.length > 0);

    const payload = {
      date,
      tz: 'UTC',
      weather: weather.today(date),
      generated_at: new Date(d.getTime() + 4 * 60 * 60 * 1000).toISOString(),
      thin: sections.length === 0,
      editors_note: sections.length === 0 ? gazette.THIN_NOTE : null,
      sections,
    };

    gazette.putIssue(db, me.id, date, { payload, weatherEntry: payload.weather });
    written++;
  }

  console.log(`seed-gazette-issues: wrote ${written} back-issues for '${username}' (${isoDate(new Date(today.getTime() - ISSUE_COUNT * 24 * 60 * 60 * 1000))}..${isoDate(new Date(today.getTime() - 24 * 60 * 60 * 1000))})`);
  db.close();
}

main();
