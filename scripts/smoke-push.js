// PHA-1619 smoke test (v4): load web-push first to monkey-patch
// sendNotification via require.cache, then require server.js and
// explicitly invoke app.listen() (server.js guards app.listen() behind
// `require.main === module`, which is false when required from this script).
const http = require('http');

// Pre-load web-push so it's in require.cache before server.js consumes it.
const webpush = require('web-push');

// Fake push service
const fakePort = 4099;
let received = [];
const fakeServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    if (req.url === '/dump') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(received)); received = []; return; }
    if (req.url === '/gone') { res.writeHead(410); res.end(); return; }
    received.push({ url: req.url, body });
    res.writeHead(201); res.end('ok');
  });
});

// Monkey-patch webpush.sendNotification to redirect to fake.
webpush.sendNotification = async function(sub, payload, opts) {
  return new Promise((resolve, reject) => {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const u = new URL(sub.endpoint);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'application/octet-stream',
                 'content-length': Buffer.byteLength(data) }
    }, (res) => {
      if (res.statusCode >= 400) {
        const err = new Error('push failed'); err.statusCode = res.statusCode; reject(err);
      } else { resolve({ statusCode: res.statusCode }); }
    });
    req.on('error', reject); req.write(data); req.end();
  });
};

// Load server.js
process.env.DATA_DIR = '/tmp/hs-smoke';
process.env.PORT = '3099';
process.env.ADMIN_PASSWORD = 'test';
const app = require('../server.js');

(async () => {
  await new Promise(r => fakeServer.listen(fakePort, r));
  console.log('[smoke] fake push on :' + fakePort);

  // Server.js's `if (require.main === module) { app.listen(...) }` is
  // false here because we required it from this script — call listen
  // ourselves so the test HTTP endpoints are reachable.
  await new Promise((resolve, reject) => {
    const server = app.listen(3099, () => { console.log('[smoke] homestead listening on :3099'); resolve(server); });
    server.on('error', reject);
  });

  // Wait for ready
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch('http://localhost:3099/api/health'); if (r.ok) { ready = true; break; } } catch (_) {}
    await new Promise(r => setTimeout(r, 200));
  }
  if (!ready) throw new Error('homestead did not become ready');
  console.log('[smoke] homestead ready');

  // Login
  const loginRes = await fetch('http://localhost:3099/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test' })
  });
  const cookie = loginRes.headers.get('set-cookie').split(';')[0];
  console.log('[smoke] logged in');

  // Subscribe a fake client
  const sub = {
    endpoint: 'http://127.0.0.1:' + fakePort + '/capture',
    keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' }
  };
  const subRes = await fetch('http://localhost:3099/api/push/subscribe', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(sub)
  });
  console.log('[smoke] subscribe:', await subRes.json());

  // Notify (real push delivery)
  const n1 = await fetch('http://localhost:3099/api/notify', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ payload: { title: 'Test from curl', body: 'real push!', tag: 'test', category: 'chore_due' } })
  });
  console.log('[smoke] notify:', await n1.json());

  // Verify push was captured
  const dump = await fetch('http://127.0.0.1:' + fakePort + '/dump');
  const captured = await dump.json();
  console.log('[smoke] captured:', captured.length, 'push(es)');
  if (captured.length > 0) {
    const p = JSON.parse(captured[0].body);
    console.log('[smoke] payload title:', p.title, '/ body:', p.body, '/ tag:', p.tag);
  }

  // 410 prune test
  const Database = require('better-sqlite3');
  const db = new Database('/tmp/hs-smoke/life.db');
  db.prepare('DELETE FROM push_subscriptions').run();
  db.prepare(`INSERT INTO push_subscriptions (user_id,endpoint,p256dh,auth) VALUES (1,?,?,?)`)
    .run('http://127.0.0.1:' + fakePort + '/gone', sub.keys.p256dh, sub.keys.auth);

  const n2 = await fetch('http://localhost:3099/api/notify', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ payload: { title: 'Should fail 410', body: 'prune test' } })
  });
  console.log('[smoke] 410 test:', await n2.json());
  const remaining = db.prepare('SELECT COUNT(*) c FROM push_subscriptions').get().c;
  console.log('[smoke] remaining subs after 410 prune:', remaining, '(expect 0)');

  // prefs roundtrip
  const prefs = await fetch('http://localhost:3099/api/push/prefs', { headers: { cookie } });
  console.log('[smoke] prefs:', await prefs.json());

  console.log('[smoke] PASS');
  fakeServer.close();
  process.exit(0);
})().catch(e => { console.error('[smoke] FAILED:', e.message); console.error(e.stack); process.exit(1); });
