#!/usr/bin/env node
// scripts/offboard-user.js — Homestead leg of the PHATT ID offboarding runbook
// (docs/OFFBOARDING.md). Host-side CLI against life.db.
//
//   DATA_DIR=... node scripts/offboard-user.js --username NAME            # dry run (default)
//   DATA_DIR=... node scripts/offboard-user.js --username NAME --export out.json
//   DATA_DIR=... node scripts/offboard-user.js --username NAME --export out.json --delete
//
// Finds every table with a foreign key to users(id) from the schema itself,
// so new modules are covered without editing this file. Export first; delete
// refuses to run unless the export file was written and is non-empty.
// Secret-looking columns are redacted from the export. Never touches the owner
// (is_admin = 1).
'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SECRET_COL = /(pass|hash|secret|token|^auth$|p256dh)/i;

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? null : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true);
}

function userRefs(db) {
  const refs = [];
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  for (const { name } of tables) {
    for (const fk of db.prepare(`PRAGMA foreign_key_list("${name}")`).all()) {
      if (fk.table === 'users') refs.push({ table: name, column: fk.from, on_delete: fk.on_delete });
    }
  }
  return refs;
}

function plan(db, user) {
  return userRefs(db).map((r) => {
    const rows = db.prepare(`SELECT * FROM "${r.table}" WHERE "${r.column}" = ?`).all(user.id);
    return { ...r, rows };
  }).filter((p) => p.rows.length);
}

function redact(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = SECRET_COL.test(k) ? '[redacted]' : v;
  return out;
}

function buildExport(db, user, p) {
  const data = { exported_at: new Date().toISOString(), user: redact(user), tables: {} };
  for (const t of p) (data.tables[`${t.table}.${t.column}`] = t.rows.map(redact));
  return data;
}

function run({ db, username, exportPath, doDelete }) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) throw new Error('no such user');
  if (user.is_admin) throw new Error('refusing: user is the owner/admin');
  const p = plan(db, user);
  const summary = p.map((t) => ({ table: t.table, column: t.column, rows: t.rows.length, on_delete: t.on_delete }));
  if (exportPath) fs.writeFileSync(exportPath, JSON.stringify(buildExport(db, user, p), null, 2), { mode: 0o600 });
  let deleted = false;
  if (doDelete) {
    if (!exportPath || !fs.existsSync(exportPath) || fs.statSync(exportPath).size === 0) {
      throw new Error('refusing to delete without a written export (--export FILE)');
    }
    db.pragma('foreign_keys = ON');
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    deleted = true;
  }
  return { user_id: user.id, summary, exported: !!exportPath, deleted };
}

if (require.main === module) {
  const username = arg('username');
  if (typeof username !== 'string') { console.error('--username required'); process.exit(2); }
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const db = new Database(path.join(dataDir, 'life.db'));
  try {
    const r = run({ db, username, exportPath: typeof arg('export') === 'string' ? arg('export') : null, doDelete: !!arg('delete') });
    console.log(JSON.stringify(r, null, 2));
    if (!r.deleted) console.log('dry run: nothing deleted' + (r.exported ? ' (export written)' : ''));
  } catch (e) { console.error('error: ' + e.message); process.exit(1); }
}

module.exports = { run, userRefs };
