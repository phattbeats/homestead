#!/usr/bin/env node
// Browser smoke for The Forum's three switchable skins.
//
//   1. Fresh DB → seed a few threads/replies through the shipped API.
//   2. Log in as brandon → /forum renders the Woodgrain index (default).
//   3. Board + thread views render; quick reply posts; Quote prefills.
//   4. Footer style chooser → Classic applies instantly, survives a
//      reload, and survives a fresh browser context (server-side pref).
//   5. Retired chrome stays gone: no FAB composer, no "+ Add a room"
//      pill, no bottom tab bar.
//   6. The Shoutbox panel: it posts, it renders, another member's
//      shout arrives live, and it sits in the right place per skin.
//   7. Polls: the sidebar Poll box votes in place, the thread list flags
//      poll threads, New Thread can attach a poll, the thread view shows
//      results + Change vote, and Night Owl stacks Poll under Shoutbox.
//   8. Screenshots: index in all three skins at desktop and 390×844,
//      board + thread in the default skin at both sizes.
//
// Seeding uses header-trust requests from Node, the same path the
// SWAG/Authentik proxy uses; there are no direct DB writes.
//
// Browser: local Playwright Chromium by default (CI). Set
// BROWSERLESS_URL=http://browserless:3000 to drive a remote Chrome over
// CDP instead; the server then binds 0.0.0.0 and the browser is pointed
// at this container's routable IP (FORUM_SMOKE_HOST, or the first
// 172.19.x address).
//
// Run: node scripts/smoke-forum-skins.js
// Output: ./verify-out/forum-*.png

'use strict';
// This smoke drives auth via X-authentik-* from 127.0.0.1 (PHA-3207 gate).
process.env.HOMESTEAD_TRUSTED_PROXIES = process.env.HOMESTEAD_TRUSTED_PROXIES || 'loopback';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-smoke-forum-skins-'));
const port = 3118;
const brandonPassword = 'smoke-forum-skins-brandon-pw';
const verifyOut = process.env.VERIFY_OUT
  ? path.resolve(process.env.VERIFY_OUT)
  : path.resolve(__dirname, '..', 'verify-out');
fs.mkdirSync(verifyOut, { recursive: true });

process.env.DATA_DIR = tmpDir;
process.env.PORT = String(port);
process.env.ADMIN_PASSWORD = 'smoke-forum-skins-admin-pw';
process.env.BRANDON_PASSWORD = brandonPassword;
process.env.SESSION_SECRET = 'smoke-forum-skins-secret-padding-to-meet-min-32-chars';
process.env.NODE_ENV = 'production';
// Session cookies are Secure in production; the smoke speaks plain http.
process.env.HOMESTEAD_INSECURE_TEST_COOKIES = '1';

const REMOTE = process.env.BROWSERLESS_URL || '';
const DESKTOP = { viewport: { width: 1280, height: 900 } };
const MOBILE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const SKINS = ['woodgrain', 'classic', 'clubhouse'];

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(label);
  else ng(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function routableHost() {
  if (process.env.FORUM_SMOKE_HOST) return process.env.FORUM_SMOKE_HOST;
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name]) if (n.family === 'IPv4' && n.address.startsWith('172.19.')) return n.address;
  }
  for (const name of Object.keys(nets)) {
    for (const n of nets[name]) if (n.family === 'IPv4' && !n.internal) return n.address;
  }
  return '127.0.0.1';
}

const API = `http://127.0.0.1:${port}`;
async function as(user, method, urlPath, body) {
  const r = await fetch(API + urlPath, {
    method,
    headers: {
      'x-authentik-username': user,
      'x-authentik-groups': user === 'admin' ? 'household,admins' : 'household',
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${urlPath} as ${user} → ${r.status} ${JSON.stringify(j)}`);
  return j;
}

async function seed() {
  for (const u of ['tyler', 'emily']) await as(u, 'GET', '/api/me');
  const mmdd = new Date().toISOString().slice(5, 10);
  await as('emily', 'PATCH', '/api/forum/me', { birthday: mmdd, signature: 'grocery run captain' });
  await as('tyler', 'PATCH', '/api/forum/me', {
    signature: "If it's not on the forum, it didn't happen.",
    now_playing: { kind: 'listening', text: 'Daft Punk — Discovery' },
  });
  const post = (user, slug, title, text) => as(user, 'POST', `/api/walls/${slug}/posts`, { kind: 'text', title, text_body: text });
  const reply = (user, id, body) => as(user, 'POST', `/api/walls/posts/${id}/comments`, { body });

  const rules = await post('admin', 'household', 'Porch rules (be nice, no politics at dinner)', 'Be kind. Tag spoilers. Put the leftovers back.');
  await as('admin', 'PATCH', `/api/forum/threads/${rules.id}`, { sticky: true });
  const light = await post('tyler', 'household', 'Who keeps leaving the porch light on??',
    "Third night in a row. I'm not naming names but their initials rhyme with \"Shmandon\".");
  await reply('brandon', light.id, '> tyler wrote:\n> their initials rhyme with "Shmandon"\nSlander. Defamation. I\'m calling a moderator.');
  await reply('emily', light.id, 'It was the cat. The cat has thumbs now.');
  await as('emily', 'POST', `/api/walls/household/posts/${light.id}/reactions`, { emoji: 'joy' });
  await as('brandon', 'POST', `/api/walls/household/posts/${light.id}/reactions`, { emoji: 'fire' });
  const pizza = await post('brandon', 'household', 'Best pizza place within 20 min? Go.', 'Ranked answers only.');
  await reply('tyler', pizza.id, 'Sal\'s. Not up for debate.');
  await post('emily', 'household', 'grocery run tonight, need anything', 'Leaving at 6.');
  await post('admin', 'announcements', 'Welcome to The Forum', 'The Porch is a forum now. Pick a style in the footer.');
  await post('emily', 'introductions', "hi it's emily!!", 'hello hello');
  const movie = await post('tyler', 'household', 'friday: horror or comedy?', 'poll is up, vote by thursday');
  const poll = await as('tyler', 'POST', `/api/forum/threads/${movie.id}/poll`, {
    question: 'friday movie?', options: ['👻 horror', '😂 comedy', '🚀 sci-fi'],
    closesAt: new Date(Date.now() + 3 * 86400000).toISOString(),
  });
  await as('emily', 'POST', `/api/forum/polls/${poll.id}/vote`, { optionId: poll.options[0].id });
  await as('tyler', 'POST', `/api/forum/polls/${poll.id}/vote`, { optionId: poll.options[1].id });
  await as('emily', 'PUT', '/api/forum/members/tyler/karma', { value: 1 });
  await as('admin', 'PUT', '/api/forum/members/tyler/karma', { value: -1 });
  return { lightId: light.id, movieId: movie.id };
}

(async () => {
  const app = require('../server.js');
  const bindHost = REMOTE ? '0.0.0.0' : '127.0.0.1';
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, bindHost, () => resolve(listener));
    listener.once('error', reject);
  });
  for (let i = 0; i < 30; i++) {
    try { if ((await fetch(`${API}/api/health`)).ok) break; } catch (_) { /* booting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  const BASE = `http://${REMOTE ? routableHost() : '127.0.0.1'}:${port}`;

  let browser;
  const pageErrors = [];
  const shot = async (page, name) => {
    const file = path.join(verifyOut, `forum-${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    ok(`screenshot: ${path.relative(process.cwd(), file)}`);
  };
  async function login(contextOpts) {
    const context = await browser.newContext(contextOpts);
    const page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(e));
    if (process.env.FORUM_SMOKE_DEBUG) page.on('console', (m) => console.log(`    [console.${m.type()}] ${m.text()}`));
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#username', { state: 'visible', timeout: 10000 });
    await page.fill('#username', 'brandon');
    await page.fill('#pw', brandonPassword);
    await page.click('#loginBtn');
    await page.waitForURL(/\/forum(\?|$)/, { timeout: 10000 });
    try {
      await page.waitForSelector('.fx-frow', { timeout: 10000 });
    } catch (e) {
      await page.screenshot({ path: path.join(verifyOut, 'forum-login-failure.png') }).catch(() => {});
      throw new Error(`/forum never rendered the index (url ${page.url()}): ${e.message.split('\n')[0]}`);
    }
    return { context, page };
  }
  const skinOf = (page) => page.evaluate(() => ({
    attr: document.documentElement.getAttribute('data-skin'),
    href: (document.getElementById('forumSkin') || {}).getAttribute ? document.getElementById('forumSkin').getAttribute('href') : null,
  }));
  async function waitSkin(page, skin) {
    await page.waitForFunction((s) => document.documentElement.getAttribute('data-skin') === s
      && document.getElementById('forumSkin').getAttribute('href') === `/forum/skin-${s}.css`, skin, { timeout: 5000 });
  }

  try {
    const { lightId, movieId } = await seed();
    ok('seeded threads, replies, reactions, birthday, signatures, a poll via the API');

    browser = REMOTE
      ? await chromium.connectOverCDP(REMOTE, { timeout: 180000 })
      : await chromium.launch({
        headless: true,
        channel: 'chromium',
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
      });

    // ---- desktop, default skin ----
    const { context: ctxA, page } = await login(DESKTOP);
    ok('login as brandon → /forum renders the board index');
    assertEq(await skinOf(page), { attr: 'woodgrain', href: '/forum/skin-woodgrain.css' }, 'default skin is Woodgrain');
    const retired = await page.evaluate(() => ({
      fab: !!document.getElementById('composeFab'),
      pill: !!document.getElementById('addRoomPill'),
      bottomNav: !!document.getElementById('hs-app-nav'),
      tabs: [...document.querySelectorAll('.fx-tabs a')].map((a) => a.innerText.trim()),
    }));
    assert(!retired.fab && !retired.pill && !retired.bottomNav, 'no FAB composer, add-room pill or bottom tab bar on /forum', JSON.stringify(retired));
    assert(['Gazette', 'Rooms', 'Invites', 'Members'].every((t) => retired.tabs.includes(t)), 'header links: Rooms · Gazette · Invites · Members', retired.tabs.join(','));
    const wgo = await page.textContent('.fx-wgo');
    assert(/Currently Active Users/.test(wgo) && /Today's Birthdays/.test(wgo) && /Homestead Statistics/.test(wgo),
      "What's Going On? shows Who's Online, birthdays and stats");
    assert(/Tyler is listening to: Daft Punk — Discovery/i.test(await page.textContent('.fx-wgo-online')),
      "Who's Online shows tyler's now-playing status", await page.textContent('.fx-wgo-online'));
    await shot(page, 'index-woodgrain-desktop');

    // ---- the sidebar poll: vote in place ----
    const sidePoll = await page.evaluate(() => ({
      box: !!document.querySelector('.fx-side .fx-pollbox'),
      q: (document.querySelector('.fx-pollbox .fx-poll-q') || {}).textContent,
      radios: document.querySelectorAll('.fx-pollbox .fx-poll-opt input[type=radio]').length,
    }));
    assertEq(sidePoll, { box: true, q: 'friday movie?', radios: 3 }, 'sidebar Poll box offers the open poll as a vote form');
    await page.click('.fx-pollbox .fx-poll-opt:nth-of-type(1) input');
    await page.click('.fx-pollbox .fx-poll-form button[type=submit]');
    await page.waitForSelector('.fx-pollbox .fx-poll-res.mine', { timeout: 10000 });
    const tally = await page.$$eval('.fx-pollbox .fx-poll-res', (els) => els.map((e) => e.querySelector('.fx-poll-n').textContent));
    assertEq(tally, ['(2)', '(1)', '(0)'], 'vote lands in place: results bars with the new tally');
    assert(/3 votes/.test(await page.textContent('.fx-pollbox .fx-poll-meta')), 'poll footer shows the vote count');

    // ---- the shoutbox panel ----
    const panel = await page.evaluate(() => {
      const sb = document.querySelector('.fx-shoutbox');
      const wg = document.querySelector('.fx-wgo');
      return {
        panel: !!sb,
        form: !!document.querySelector('#shoutForm'),
        list: !!document.querySelector('#shoutList'),
        sbTop: sb ? sb.getBoundingClientRect().top : null,
        wgoTop: wg ? wg.getBoundingClientRect().top : null,
      };
    });
    assert(panel.panel && panel.form && panel.list, 'index shows the Shoutbox panel with a post form', JSON.stringify(panel));
    assert(panel.sbTop > panel.wgoTop, "Woodgrain: the Shoutbox sits after What's Going On?", JSON.stringify(panel));

    await page.fill('#shoutBody', 'smoke test shout from the forum');
    await page.click('#shoutForm button[type=submit]');
    await page.waitForFunction(
      () => /smoke test shout from the forum/.test(document.getElementById('shoutList').textContent),
      null, { timeout: 10000 });
    ok('posted shout renders in the shoutbox');

    // another member's shout lands live, without a reload
    await as('emily', 'POST', '/api/shoutbox', { body: 'live shout from emily' });
    await page.waitForFunction(
      () => /live shout from emily/.test(document.getElementById('shoutList').textContent),
      null, { timeout: 10000 });
    ok('a shout from another member arrives live over SSE');
    await shot(page, 'index-woodgrain-shoutbox');

    // collapse a category, and it stays collapsed after reload
    await page.click('.fx-cat .fx-x');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.fx-cat', { timeout: 10000 });
    assert(await page.evaluate(() => document.querySelector('.fx-cat').classList.contains('collapsed')), 'collapsed category persists across reload');
    await page.click('.fx-cat .fx-x');

    // board view
    await page.click('a.fx-board[href="/forum?wall=household"]');
    await page.waitForSelector('.fx-trow', { timeout: 10000 });
    const rows = await page.$$eval('.fx-trow .t', (els) => els.map((e) => e.textContent));
    assert(/^Sticky:/.test(rows[0]), 'sticky thread is listed first', rows[0]);
    assertEq(page.url(), `${BASE}/forum?wall=household`, 'board URL is /forum?wall=household');
    assert(rows.some((t) => /^Poll: friday: horror or comedy\?/.test(t)), 'thread list flags the poll thread', rows.join(' | '));
    await shot(page, 'board-woodgrain-desktop');

    // new thread from the board
    await page.click('[data-action=new-thread]');
    await page.fill('#newThread input[name=title]', 'Smoke test thread');
    await page.fill('#newThread textarea[name=text]', 'posted from the board view');
    await page.click('#newThread .fx-pollopt summary');
    await page.fill('#newThread input[name=pollQuestion]', 'smoke poll?');
    await page.fill('#newThread textarea[name=pollOptions]', 'only one');
    await page.click('#newThread button[type=submit]');
    assert(/at least two options/.test(await page.textContent('#newThread .fx-err')), 'half-filled poll is caught before the thread posts');
    await page.fill('#newThread textarea[name=pollOptions]', 'yes\nno');
    await page.click('#newThread button[type=submit]');
    await page.waitForURL(/\?post=/, { timeout: 10000 });
    await page.waitForSelector('.fx-post', { timeout: 10000 });
    assertEq(await page.textContent('.fx-thread-box .fx-thead span'), 'Smoke test thread', 'New Thread lands on the new thread');
    assertEq(await page.$$eval('.fx-pollbox-thread .fx-poll-opt', (els) => els.map((e) => e.textContent.trim())), ['yes', 'no'],
      'New Thread with a poll: the thread opens with its poll');
    // Close it so the seeded movie poll stays the sidebar's newest open poll.
    const smokeThread = new URL(page.url()).searchParams.get('post');
    const smokePoll = (await as('brandon', 'GET', `/api/forum/threads/${smokeThread}`)).poll;
    await as('brandon', 'PATCH', `/api/forum/polls/${smokePoll.id}`, { closed: true });

    // thread view of the seeded poll: results, my vote, Change vote
    await page.goto(`${BASE}/forum?post=${movieId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.fx-pollbox-thread .fx-poll-res.mine', { timeout: 10000 });
    ok('poll thread shows results with my vote marked');
    await page.click('.fx-pollbox-thread [data-action=poll-change]');
    await page.click('.fx-pollbox-thread .fx-poll-opt:nth-of-type(3) input');
    await page.click('.fx-pollbox-thread .fx-poll-form button[type=submit]');
    await page.waitForFunction(() => /sci-fi/.test((document.querySelector('.fx-pollbox-thread .fx-poll-res.mine') || {}).textContent || ''), null, { timeout: 10000 });
    ok('Change vote moves my vote');
    assertEq(await page.$$eval('.fx-pollbox-thread .fx-poll-n', (els) => els.map((e) => e.textContent)), ['(1)', '(1)', '(1)'], 'one vote per member: tally unchanged in total');
    await shot(page, 'thread-poll-woodgrain-desktop');

    // thread view
    await page.goto(`${BASE}/forum?post=${lightId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.fx-post', { timeout: 10000 });
    const thread = await page.evaluate(() => ({
      posts: document.querySelectorAll('.fx-post').length,
      quote: !!document.querySelector('.fx-post .fx-quote'),
      sig: !!document.querySelector('.fx-sig'),
      np: (document.querySelector('.fx-post .fx-sig .fx-np') || {}).textContent || null,
      rank: document.querySelector('.fx-rank') && document.querySelector('.fx-rank').textContent,
      crumbs: document.querySelector('.fx-crumb').textContent,
    }));
    assertEq(thread.posts, 3, 'thread shows the opener + 2 replies');
    assert(/Listening to: Daft Punk/.test(thread.np || ''), "postbit signature shows the author's now-playing", thread.np);
    assert(thread.quote && thread.sig && thread.rank, 'postbit shows quote block, signature and rank', JSON.stringify(thread));
    assert(/The Forum.*General Chit-Chat.*porch light/.test(thread.crumbs), 'breadcrumbs: Forum › board › thread', thread.crumbs);
    assertEq(await page.$$eval('.fx-karma', (els) => els.filter((e) => e.offsetParent !== null).length), 0, 'Woodgrain: karma stays hidden (Night Owl only)');
    await shot(page, 'thread-woodgrain-desktop');

    await page.click('.fx-post:nth-of-type(3) [data-action=quote]');
    const quoted = await page.inputValue('#quickReply textarea');
    assert(/^> emily wrote:\n> It was the cat/i.test(quoted), 'Quote prefills the quick reply', JSON.stringify(quoted));
    await page.fill('#quickReply textarea', 'smoke reply');
    await page.click('#quickReply [data-action=smilie]');
    await page.click('#quickReply button[type=submit]');
    await page.waitForFunction(() => document.querySelectorAll('.fx-post').length === 4, null, { timeout: 10000 });
    ok('quick reply posts and re-renders the thread');
    await page.click('.fx-react [data-emoji="+1"]');
    await page.waitForFunction(() => document.querySelector('.fx-react [data-emoji="+1"]').getAttribute('aria-pressed') === 'true', null, { timeout: 10000 });
    ok('Thanks toggles a reaction');

    // ---- skin switch from the footer chooser ----
    await page.goto(`${BASE}/forum`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#skinChooser', { timeout: 10000 });
    const patch = page.waitForResponse((r) => r.url().endsWith('/api/forum/me') && r.request().method() === 'PATCH', { timeout: 5000 });
    await page.selectOption('#skinChooser', 'classic');
    await waitSkin(page, 'classic');
    assertEq((await patch).status(), 200, 'chooser PATCHes /api/forum/me');
    ok('footer chooser applies Classic instantly');
    await page.reload({ waitUntil: 'domcontentloaded' });
    assertEq((await skinOf(page)).attr, 'classic', 'Classic is painted on reload (before the API answers)');
    await page.waitForSelector('.fx-frow', { timeout: 10000 });
    await waitSkin(page, 'classic');
    ok('Classic persists across reload');
    await ctxA.close();

    const { context: ctxB, page: fresh } = await login(DESKTOP);
    await waitSkin(fresh, 'classic');
    ok('fresh browser context + login → still Classic (server-side preference)');
    const me = await fresh.evaluate(async () => (await (await fetch('/api/me')).json()).forum_skin);
    assertEq(me, 'classic', '/api/me.forum_skin === classic');
    const bad = await fresh.evaluate(async () => (await fetch('/api/forum/me', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ forum_skin: 'geocities' }),
    })).status);
    assertEq(bad, 400, 'unknown skin name → 400');

    // ---- desktop screenshots of every skin's index ----
    for (const skin of SKINS) {
      await fresh.selectOption('#skinChooser', skin);
      await waitSkin(fresh, skin);
      await fresh.waitForTimeout(200);
      if (skin === 'clubhouse') {
        const slots = await fresh.evaluate(() => ['.fx-marquee', '.fx-counter', '.fx-wgo-top'].map((s) => {
          const el = document.querySelector(s); return !!el && getComputedStyle(el).display !== 'none';
        }));
        assertEq(slots, [true, true, true], 'Night Owl shows marquee, hit counter and Top Posters');
      } else {
        const hidden = await fresh.evaluate(() => getComputedStyle(document.querySelector('.fx-marquee')).display);
        assertEq(hidden, 'none', `${skin}: Night Owl marquee stays hidden`);
      }
      const shoutbox = await fresh.evaluate(() => {
        const sb = document.querySelector('.fx-shoutbox');
        const wg = document.querySelector('.fx-wgo');
        return {
          sbTop: sb ? sb.getBoundingClientRect().top : null,
          wgoTop: wg ? wg.getBoundingClientRect().top : null,
          text: (document.getElementById('shoutList') || {}).textContent || '',
        };
      });
      assert(skin === 'clubhouse' ? shoutbox.sbTop < shoutbox.wgoTop : shoutbox.sbTop > shoutbox.wgoTop,
        skin === 'clubhouse'
          ? 'Night Owl: the Shoutbox leads the right column'
          : `${skin}: the Shoutbox sits after What's Going On?`,
        JSON.stringify(shoutbox));
      assert(/smoke test shout from the forum/.test(shoutbox.text), `${skin}: the Shoutbox shows the household's shouts`);
      const pollBox = await fresh.evaluate(() => {
        const top = (s) => { const el = document.querySelector(s); return el ? el.getBoundingClientRect().top : null; };
        const bar = document.querySelector('.fx-pollbox .fx-poll-bar span');
        return {
          poll: top('.fx-pollbox'), shout: top('.fx-shoutbox'), online: top('.fx-wgo-online'),
          bars: document.querySelectorAll('.fx-pollbox .fx-poll-bar').length,
          barColor: bar ? getComputedStyle(bar).backgroundColor : null,
        };
      });
      assertEq(pollBox.bars, 3, `${skin}: sidebar poll renders three vote bars`);
      if (skin === 'clubhouse') {
        assert(pollBox.shout < pollBox.poll && pollBox.poll < pollBox.online, 'Night Owl: Poll sits under the Shoutbox, above Who\'s Online', JSON.stringify(pollBox));
        assertEq(pollBox.barColor, 'rgb(127, 255, 212)', 'Night Owl: aqua vote bars');
      } else {
        assert(pollBox.poll !== null && pollBox.poll > pollBox.online, `${skin}: Poll box follows What's Going On?`, JSON.stringify(pollBox));
      }
      await shot(fresh, `index-${skin}-desktop`);
    }
    await fresh.selectOption('#skinChooser', 'clubhouse');
    await waitSkin(fresh, 'clubhouse');
    await fresh.goto(`${BASE}/forum?post=${movieId}`, { waitUntil: 'domcontentloaded' });
    await fresh.waitForSelector('.fx-pollbox-thread .fx-poll-res', { timeout: 10000 });
    await shot(fresh, 'thread-poll-clubhouse-desktop');
    // karma in the Night Owl postbit: "karma: +1 / -1" on tyler's opener,
    // + gives brandon's vote, no buttons on brandon's own reply.
    await fresh.goto(`${BASE}/forum?post=${lightId}`, { waitUntil: 'domcontentloaded' });
    await fresh.waitForSelector('.fx-post .fx-karma', { state: 'visible', timeout: 10000 });
    const karmaText = () => fresh.$eval('.fx-post:first-of-type .fx-karma', (e) => e.textContent.replace(/\s+/g, ' ').trim());
    assert(/^karma: \+1 \/ -1/.test(await karmaText()), 'Night Owl postbit shows karma: +1 / -1', await karmaText());
    assertEq(await fresh.$$eval('.fx-post:nth-of-type(2) .fx-kbtn', (els) => els.length), 0, 'no karma buttons on your own postbit');
    await fresh.click('.fx-post:first-of-type .fx-kbtn[data-value="1"]');
    await fresh.waitForFunction(() => /karma: \+2 \/ -1/.test(document.querySelector('.fx-post:first-of-type .fx-karma').textContent), null, { timeout: 10000 });
    assertEq(await fresh.getAttribute('.fx-post:first-of-type .fx-kbtn[data-value="1"]', 'aria-pressed'), 'true', '+ gives karma and marks my vote');
    await shot(fresh, 'thread-karma-clubhouse-desktop');
    await fresh.click('.fx-post:first-of-type .fx-kbtn[data-value="1"]');
    await fresh.waitForFunction(() => /karma: \+1 \/ -1/.test(document.querySelector('.fx-post:first-of-type .fx-karma').textContent), null, { timeout: 10000 });
    ok('pressing + again takes the vote back');
    await ctxB.close();

    // ---- mobile 390×844 ----
    const { context: ctxM, page: mob } = await login(MOBILE);
    for (const skin of SKINS) {
      await mob.selectOption('#skinChooser', skin);
      await waitSkin(mob, skin);
      await mob.waitForTimeout(200);
      const overflow = await mob.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert(overflow <= 0, `${skin}: no horizontal overflow at 390px`, `overflow ${overflow}px`);
      await shot(mob, `index-${skin}-mobile`);
    }
    await mob.selectOption('#skinChooser', 'woodgrain');
    await waitSkin(mob, 'woodgrain');
    await mob.click('a.fx-board[href="/forum?wall=household"]');
    await mob.waitForSelector('.fx-trow', { timeout: 10000 });
    await shot(mob, 'board-woodgrain-mobile');
    await mob.goto(`${BASE}/forum?post=${lightId}`, { waitUntil: 'domcontentloaded' });
    await mob.waitForSelector('.fx-post', { timeout: 10000 });
    await shot(mob, 'thread-woodgrain-mobile');
    await ctxM.close();

    if (pageErrors.length) ng(`pageerrors: ${pageErrors.map((e) => e.message).join('; ')}`);
    else ok('no pageerrors during the run');
  } catch (e) {
    ng('smoke aborted', e && e.stack ? e.stack : String(e));
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
