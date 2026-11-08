#!/usr/bin/env node
// offboard-user: export is written + redacted, delete removes every row that
// references the user, owner and other members are untouched.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'offboard-'));
process.env.DATA_DIR = tmp;
const Database = require('better-sqlite3');
const server = require('../server.js');
const { run, userRefs } = require('./offboard-user.js');

const db = new Database(path.join(tmp, 'life.db'));
db.pragma('foreign_keys = ON');
const mk = (u, admin = 0) => db.prepare("INSERT INTO users (username, display, pass_hash, is_admin) VALUES (?,?,?,?)").run(u, u, 'secrethash', admin).lastInsertRowid;
const owner = mk('zz-owner', 1), t = mk('zz-offboard-test'), other = mk('zz-other');
for (const id of [t, other]) {
  db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?,?,?,?)").run(id, 'https://x/' + id, 'k', 'a');
}
assert(userRefs(db).length > 10, 'schema discovery found FK tables');

const exp = path.join(tmp, 'export.json');
assert.throws(() => run({ db, username: 'zz-owner', exportPath: exp, doDelete: true }), /owner/);
assert.throws(() => run({ db, username: 'zz-offboard-test', exportPath: null, doDelete: true }), /without a written export/);
let r = run({ db, username: 'zz-offboard-test', exportPath: exp, doDelete: false });
assert(!r.deleted && db.prepare('SELECT 1 FROM users WHERE id=?').get(t), 'dry run keeps user');
const body = fs.readFileSync(exp, 'utf8');
assert(!body.includes('secrethash') && body.includes('[redacted]'), 'secrets redacted');
assert(JSON.parse(body).tables['push_subscriptions.user_id'].length === 1);
r = run({ db, username: 'zz-offboard-test', exportPath: exp, doDelete: true });
assert(r.deleted);
assert(!db.prepare('SELECT 1 FROM users WHERE id=?').get(t), 'user gone');
for (const ref of userRefs(db)) {
  if (ref.on_delete === 'CASCADE') assert.strictEqual(db.prepare(`SELECT COUNT(*) c FROM "${ref.table}" WHERE "${ref.column}"=?`).get(t).c, 0, ref.table);
}
assert(db.prepare('SELECT 1 FROM users WHERE id=?').get(owner) && db.prepare('SELECT 1 FROM push_subscriptions WHERE user_id=?').get(other), 'others untouched');
console.log('offboard-user: ok');
process.exit(0);
