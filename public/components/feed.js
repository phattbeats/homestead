// Homestead — Wall feed/composer/reactions component (PHA-2200.5 / PHA-2206).
//
// Placement-agnostic feed module extracted from public/porch.js (PHA-2151).
// Mounts the full wall surface (composer, chronological feed, reactions,
// comments, "Older" pagination) into ANY container, with optional canPost /
// canReact / canComment gates. Used in two placements per PHA-2200 §6:
//
//   1. /porch.html — full-page standalone (single-wall or wall-picker mode)
//   2. /index.html — inside #page-wall when the wall module is enabled
//                    alongside other modules (meadow / feed-tabs layout)
//
// The third path — the `wall` module being the SOLE enabled module — is
// served by /porch.html redirect from /api/me/layout's `defaultRoute`.
// This component is identical in both placements; the only difference is
// the chrome (back button, nav) and the page transition logic.
//
// Vanilla JS, no framework, no build step — same convention as
// public/index.html / public/porch.js. Talks to the wall/media routes
// added in PHA-2150/PHA-2149 (lib/walls.js, lib/media.js) plus the
// GET /api/link-preview route added alongside PHA-2151.
//
// Contract:
//   window.HomesteadFeed.mount(target, opts) -> { dispose, setWall, root }
//     target:  HTMLElement to render into (its existing children are kept;
//              the component appends a .feed-root child)
//     opts:    { apiBase='/api', wallSlug=null (default: first wall),
//                canPost=true, canReact=true, canComment=true }
//   window.HomesteadFeed.unmount(target)
//     Disposes the instance bound to target. If target was never mounted,
//     no-op.
//
// The component is idempotent: mounting into an already-mounted target
// unmounts the previous instance first so callers don't have to track
// lifecycle. Two placements (porch.html + index.html's #page-wall) coexist
// in different frames / tabs without collision because each mount is keyed
// to its own target.

'use strict';

(function () {
  // Shared constants — these are immutable across instances.
  const REACTIONS = Object.freeze([
    Object.freeze({ emoji: '+1',    label: '👍' }),
    Object.freeze({ emoji: 'joy',   label: '😂' }),
    Object.freeze({ emoji: 'fire',  label: '🔥' }),
    Object.freeze({ emoji: 'eyes',  label: '👀' }),
    Object.freeze({ emoji: 'heart', label: '❤️' }),
  ]);

  // Instance map: lets `unmount(target)` find the right instance and lets
  // idempotent re-mount clean up the previous binding. WeakMap so
  // disposing the target element doesn't leak memory.
  const INSTANCES = new WeakMap();

  // ---------------------------------------------------------------------------
  // Pure helpers (no DOM, no state — reusable across instances + tests).
  // ---------------------------------------------------------------------------

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function cssEsc(s) {
    return String(s).replace(/["\\]/g, '\\$&');
  }

  function debounce(fn, ms) {
    let busy = false;
    return function (...args) {
      if (busy) return;
      busy = true;
      Promise.resolve(fn.apply(this, args)).finally(() => setTimeout(() => { busy = false; }, ms));
    };
  }

  function fmtTime(iso) {
    try {
      const d = new Date(iso.replace(' ', 'T') + 'Z');
      return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch (_) { return iso || ''; }
  }

  function postMediaHtml(p) {
    if (p.kind === 'image') {
      const url = `/api/media/${p.mediaId}`;
      return `<div class="post-media"><img src="${esc(url)}" loading="lazy" alt=""></div>`;
    }
    if (p.kind === 'video') {
      const url = `/api/media/${p.mediaId}`;
      return `<div class="post-media"><video src="${esc(url)}" controls preload="metadata"></video></div>`;
    }
    if (p.kind === 'link' && p.link) {
      return `<a class="post-link" href="${esc(p.link.url)}" target="_blank" rel="noopener noreferrer">
        <div class="lp-title">${esc(p.link.title || p.link.url)}</div>
        ${p.link.description ? `<div class="lp-desc">${esc(p.link.description)}</div>` : ''}
        <div class="lp-url">${esc(p.link.url)}</div>
      </a>`;
    }
    if (p.kind === 'text') {
      return `<div class="post-body">${esc(p.text)}</div>`;
    }
    return '';
  }

  function reactionsHtml(p) {
    const mine = new Set(p.myReactions || []);
    return `<div class="reactions" data-post="${esc(p.id)}">${REACTIONS.map((r) => {
      const count = (p.reactionSummary && p.reactionSummary[r.emoji]) || 0;
      return `<button type="button" class="reaction${mine.has(r.emoji) ? ' mine' : ''}" data-emoji="${r.emoji}">
        <span>${r.label}</span>${count ? `<span class="rc">${count}</span>` : ''}
      </button>`;
    }).join('')}</div>`;
  }

  // PHA-2648: honest-identity badge + one-click opt-out for Porch agents.
  // isAgent is derived server-side from a live agent_tokens row (never a
  // self-reported flag) — see lib/walls.js's userView(). Used for BOTH
  // post authors and comment authors: an agent's actual Porch output is
  // most often a comment/reaction on someone else's post (PHA-2645's
  // participation contract), not a post of its own.
  function authorBadgeHtml(author) {
    if (!author || !author.isAgent) return '';
    const username = esc(author.username || '');
    return `<span class="agent-badge" title="This account posts as a Porch agent">🤖 Agent</span>
      <button type="button" class="agent-vote-off" data-username="${username}"
        title="Vote this agent off the porch">Vote off</button>`;
  }

  function postHtml(p) {
    const author = (p.author && (p.author.display || p.author.username)) || 'Someone';
    return `<div class="post${p._pending ? ' pending' : ''}" data-id="${esc(p.id)}">
      <div class="post-head">
        <div class="post-author">${esc(author)}${authorBadgeHtml(p.author)}</div>
        <div class="post-time">${esc(fmtTime(p.createdAt))}</div>
      </div>
      ${postMediaHtml(p)}
      ${reactionsHtml(p)}
      <div class="comments-toggle" data-post="${esc(p.id)}">
        <span class="arrow">›</span> Comments${p.commentCount ? ` (${p.commentCount})` : ''}
      </div>
      <div class="comments" data-post="${esc(p.id)}">
        <div class="comments-list"></div>
        <form class="comment-form" data-post="${esc(p.id)}">
          <input type="text" placeholder="Add a comment…" maxlength="1000">
          <button type="submit">Send</button>
        </form>
      </div>
    </div>`;
  }

  // ---------------------------------------------------------------------------
  // Factory: create a new instance bound to a target element. Each instance
  // owns its own state (ME, WALLS, WALL, POSTS, CURSOR, etc.), DOM refs
  // scoped via `.feed-root`, and a disposers list for cleanup. boot() is
  // exposed on the returned object so mount() can kick it off after the
  // instance is fully bound.
  // ---------------------------------------------------------------------------

  function createInstance(target, cfg) {
    const root = document.createElement('div');
    root.className = 'feed-root';
    target.appendChild(root);

    // Per-instance state.
    let ME = null;
    let WALLS = [];
    let WALL = cfg.wallSlug || null;
    let POSTS = [];
    let CURSOR = null;
    let HAS_MORE = true;
    let PENDING_MEDIA = null;
    let linkPreviewData = null;
    let aborter = null;        // AbortController for boot fetches so
                               // unmount can cancel an early-boot fetch.
    const disposers = [];      // [{el, evt, fn, opts}] for addEventListener cleanup.

    // Scope-bound helpers.
    const $  = (s, el) => (el || root).querySelector(s);
    const $$ = (s, el) => Array.from((el || root).querySelectorAll(s));

    function on(el, evt, fn, opts) {
      if (!el) return;
      el.addEventListener(evt, fn, opts);
      disposers.push({ el, evt, fn, opts });
    }

    function toast(msg, isErr) {
      // Toast lives inside the root so it cleans up with the instance.
      let el = $('#toast', root);
      if (!el) {
        el = document.createElement('div');
        el.id = 'toast';
        root.appendChild(el);
      }
      el.textContent = msg;
      el.classList.toggle('err', !!isErr);
      el.classList.add('on');
      clearTimeout(toast._t);
      toast._t = setTimeout(() => el.classList.remove('on'), 3200);
    }

    async function api(method, path, body, isForm, signal) {
      const opts = { method, credentials: 'same-origin', headers: {} };
      if (signal) opts.signal = signal;
      if (body && !isForm) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      } else if (isForm) {
        opts.body = body;
      }
      const r = await fetch(url(path), opts);
      let data = null;
      try { data = await r.json(); } catch (_) { data = null; }
      if (!r.ok) {
        const err = new Error((data && data.error) || `HTTP ${r.status}`);
        err.status = r.status;
        err.body = data;
        throw err;
      }
      return data;
    }

    // Join apiBase + a path that starts with '/'. Avoids double-slashes.
    function url(path) {
      const base = cfg.apiBase || '/api';
      const b = base.endsWith('/') ? base.slice(0, -1) : base;
      const p = path.startsWith('/') ? path : '/' + path;
      return b + p;
    }

    // ---- shell render ----

    function renderShell() {
      const composerHtml = cfg.canPost ? `
    <div id="composer" class="card">
      <div class="composer-tabs">
        <button type="button" class="ctab on" data-kind="text">Text</button>
        <button type="button" class="ctab" data-kind="media">Photo/Video</button>
        <button type="button" class="ctab" data-kind="link">Link</button>
      </div>

      <div class="cpane on" id="pane-text">
        <textarea id="textBody" maxlength="2000" placeholder="What's happening on the porch?" rows="3"></textarea>
        <div class="composer-row">
          <span class="charcount" id="textCount">0 / 2000</span>
          <button type="button" class="btn" id="postText">Post</button>
        </div>
      </div>

      <div class="cpane" id="pane-media">
        <div id="dropZone" class="drop-zone">
          <div class="drop-hint">Drag a photo/video here, paste, or</div>
          <label class="btn btn-secondary" for="fileInput">Choose file</label>
          <input type="file" id="fileInput" accept="image/*,video/*" hidden>
        </div>
        <div id="uploadStatus" class="upload-status"></div>
      </div>

      <div class="cpane" id="pane-link">
        <input type="url" id="linkUrl" placeholder="https://…" class="field">
        <div id="linkPreview" class="link-preview"></div>
        <div class="composer-row">
          <button type="button" class="btn" id="postLink">Post link</button>
        </div>
      </div>
    </div>` : '';

      const pickerHtml = `
    <select id="wallPicker" aria-label="Choose wall"></select>
    <select id="notifyLevel" aria-label="Notification level for this wall">
      <option value="all">Notify: All</option>
      <option value="mentions">Notify: Mentions only</option>
      <option value="none">Notify: None</option>
    </select>`;

      // PHA-2727 comp A: on the wall-only screen (no other modules enabled,
      // no bottom bar to dock into) the single available action becomes a
      // centered floating "+" button, and profile/settings — which had no
      // entry point at all on this standalone shell — move into a "⋯"
      // utility chip in the header. Both are opt-in via cfg so the
      // meadow/feed-tabs placement (mounted inside index.html, which already
      // has its own fab/avatar/nav chrome) is unaffected.
      const utilChipHtml = cfg.utilityChip ? `<button type="button" id="utilChip" class="util-chip" aria-label="Profile and settings">⋯</button>` : '';
      const composerWrapOpen = cfg.primaryFab ? '' : ' on';

      root.innerHTML = `
  <header>
    <div class="header-lockup"><a class="brand-lockup" href="/" aria-label="Homestead home"><img src="/icon.svg" alt="" class="brand-icon"><img src="/wordmark.svg" alt="Homestead" class="brand-wordmark"></a><div class="greet"><small id="feedLabel">The Porch</small><span id="wallName">Wall</span></div></div>
    ${pickerHtml}
    ${utilChipHtml}
  </header>

  <main id="main">
    <div id="composerWrap" class="composer-wrap-toggle${composerWrapOpen}">${composerHtml}</div>
    <div id="feed"></div>
    <div class="older-wrap">
      <button type="button" class="btn btn-secondary" id="olderBtn" hidden>Older</button>
    </div>
  </main>
  ${cfg.primaryFab ? `<button type="button" id="composeFab" class="compose-fab" aria-label="New post">+</button>` : ''}
  ${cfg.utilityChip ? `
  <div id="utilSheet" class="util-overlay">
    <div class="util-sheet">
      <h2 id="utilName">You</h2>
      <button type="button" class="link util-close" id="utilClose" style="position:absolute;top:16px;right:18px">✕</button>
      <h3>Change your password</h3>
      <input class="field" type="password" id="utilCurPw" placeholder="Current password" autocomplete="current-password">
      <input class="field" type="password" id="utilNewPw" placeholder="New password" autocomplete="new-password">
      <button type="button" class="btn" id="utilPwSave">Update password</button>
      <div class="err" id="utilPwErr"></div>
      <button type="button" class="link" style="margin-top:16px;width:100%;text-align:center" id="utilLogout">Log out</button>
    </div>
  </div>` : ''}`;
    }

    // ---- boot ----

    async function boot() {
      aborter = new AbortController();
      // Render the static shell (header, composer, feed container)
      // BEFORE the first network round-trip — that way the user sees
      // a populated UI immediately, and the caller's `state: 'visible'`
      // selectors (Playwright smokes, screenshots) find their targets
      // even on a slow network. The pre-fix boot() didn't call
      // renderShell(), leaving an empty <div class="feed-root"> until
      // loadPosts() succeeded — a regression in the PHA-2206 extraction
      // (renderShell was defined but never invoked).
      renderShell();
      try {
        const me = await api('GET', '/me', null, false, aborter.signal);
        ME = me && me.user;
      } catch (e) {
        if (e.name === 'AbortError') return;
        ME = null;
      }
      if (!ME) {
        if (window.location.pathname !== '/') window.location.href = '/';
        return;
      }

      let wallsRes;
      try {
        wallsRes = await api('GET', '/walls', null, false, aborter.signal);
      } catch (e) {
        if (e.name === 'AbortError') return;
        toast('Could not load walls', true);
        return;
      }
      WALLS = (wallsRes && wallsRes.walls) || [];
      if (!WALLS.length) {
        const main = $('#main', root);
        if (main) main.innerHTML = '<div class="empty">No walls yet. Ask an admin to add you to one.</div>';
        const picker = $('#wallPicker', root);
        if (picker) picker.style.display = 'none';
        return;
      }
      renderWallPicker();
      if (!WALL || !WALLS.find((w) => w.slug === WALL)) {
        WALL = WALLS[0].slug;
      }
      const cur = WALLS.find((w) => w.slug === WALL) || WALLS[0];
      $('#wallName', root).textContent = (cur && (cur.name || cur.slug)) || WALL;
      await loadPosts(true);

      if (cfg.canPost) wireComposer();
      wireOlder();
      if (cfg.primaryFab) wireComposeFab();
      if (cfg.utilityChip) wireUtilChip();
    }

    // PHA-2727: centered FAB toggles the composer card open/closed instead
    // of it always occupying the top of the feed. Closes again after a
    // successful post so the wall reads as content-first between posts.
    function wireComposeFab() {
      const fab = $('#composeFab', root);
      const wrap = $('#composerWrap', root);
      if (!fab || !wrap) return;
      on(fab, 'click', () => {
        const opening = !wrap.classList.contains('on');
        wrap.classList.toggle('on', opening);
        fab.classList.toggle('open', opening);
        if (opening) {
          wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
          const textArea = $('#textBody', root);
          if (textArea) textArea.focus();
        }
      });
    }

    function closeComposeFab() {
      const wrap = $('#composerWrap', root);
      const fab = $('#composeFab', root);
      if (!cfg.primaryFab || !wrap) return;
      wrap.classList.remove('on');
      if (fab) fab.classList.remove('open');
    }

    // PHA-2727: the standalone porch shell had no profile/settings entry
    // point at all (that chrome lives only in index.html's header). The
    // "⋯" chip surfaces the minimal set every user needs — password change,
    // logout — without pulling in the admin-only settings sheet.
    function wireUtilChip() {
      const chip = $('#utilChip', root);
      const sheet = $('#utilSheet', root);
      if (!chip || !sheet) return;
      on(chip, 'click', () => {
        const nameEl = $('#utilName', root);
        if (nameEl) nameEl.textContent = (ME && (ME.display || ME.username)) || 'You';
        sheet.classList.add('on');
      });
      const close = () => sheet.classList.remove('on');
      const closeBtn = $('#utilClose', root);
      if (closeBtn) on(closeBtn, 'click', close);
      on(sheet, 'click', (e) => { if (e.target === sheet) close(); });
      const saveBtn = $('#utilPwSave', root);
      if (saveBtn) {
        on(saveBtn, 'click', async () => {
          const errEl = $('#utilPwErr', root);
          if (errEl) errEl.textContent = '';
          try {
            await api('POST', '/password', {
              current: $('#utilCurPw', root).value,
              next: $('#utilNewPw', root).value,
            });
            close();
          } catch (e) {
            if (errEl) errEl.textContent = (e.body && e.body.error) || 'Failed';
          }
        });
      }
      const logoutBtn = $('#utilLogout', root);
      if (logoutBtn) {
        on(logoutBtn, 'click', async () => {
          await api('POST', '/logout');
          window.location.reload();
        });
      }
    }

    function renderWallPicker() {
      const picker = $('#wallPicker', root);
      if (!picker) return;
      if (WALLS.length <= 1) {
        picker.style.display = 'none';
        return;
      }
      picker.innerHTML = WALLS.map((w) => `<option value="${esc(w.slug)}">${esc(w.name || w.slug)}</option>`).join('');
      picker.value = WALL || WALLS[0].slug;
      on(picker, 'change', async () => {
        WALL = picker.value;
        const w = WALLS.find((x) => x.slug === WALL);
        $('#wallName', root).textContent = (w && w.name) || WALL;
        await loadPosts(true);
      });
    }

    // ---- feed ----

    async function loadPosts(reset) {
      if (reset) { POSTS = []; CURSOR = null; HAS_MORE = true; }
      const qs = new URLSearchParams({ limit: '20' });
      if (CURSOR) qs.set('cursor', CURSOR);
      let res;
      try {
        res = await api('GET', `/walls/${encodeURIComponent(WALL)}/posts?${qs.toString()}`);
      } catch (e) {
        if (e.name === 'AbortError') return;
        toast('Could not load posts', true);
        return;
      }
      const page = res.posts || [];
      POSTS = reset ? page : POSTS.concat(page);
      if (page.length) CURSOR = page[page.length - 1].createdAt;
      HAS_MORE = page.length >= 20;
      const older = $('#olderBtn', root);
      if (older) older.hidden = !HAS_MORE;
      renderFeed();
    }

    function wireOlder() {
      const btn = $('#olderBtn', root);
      if (!btn) return;
      on(btn, 'click', () => loadPosts(false));
    }

    function renderFeed() {
      const feed = $('#feed', root);
      if (!feed) return;
      if (!POSTS.length) {
        feed.innerHTML = '<div class="empty">No posts yet. Be the first!</div>';
        return;
      }
      feed.innerHTML = POSTS.map(postHtml).join('');
      wireFeedEvents();
    }

    function wireFeedEvents() {
      if (cfg.canReact) {
        $$('.reaction', root).forEach((btn) => {
          on(btn, 'click', debounce(() => onReactClick(btn), 300));
        });
      } else {
        $$('.reactions', root).forEach((row) => { row.style.display = 'none'; });
      }
      $$('.comments-toggle', root).forEach((el) => {
        on(el, 'click', () => onCommentsToggle(el));
      });
      $$('.agent-vote-off', root).forEach((btn) => {
        on(btn, 'click', () => onVoteOffClick(btn));
      });
      if (cfg.canComment) {
        $$('.comment-form', root).forEach((f) => {
          on(f, 'submit', (e) => onCommentSubmit(e, f));
        });
      } else {
        $$('.comment-form', root).forEach((f) => { f.style.display = 'none'; });
      }
    }

    async function onReactClick(btn) {
      const row = btn.closest('.reactions');
      const postId = row.dataset.post;
      const emoji = btn.dataset.emoji;
      const post = POSTS.find((p) => p.id === postId);
      if (!post) return;
      const mine = new Set(post.myReactions || []);
      const wasMine = mine.has(emoji);
      // optimistic
      if (wasMine) {
        mine.delete(emoji);
        post.reactionSummary[emoji] = Math.max(0, (post.reactionSummary[emoji] || 1) - 1);
      } else {
        mine.add(emoji);
        post.reactionSummary[emoji] = (post.reactionSummary[emoji] || 0) + 1;
      }
      post.myReactions = Array.from(mine);
      renderFeed();
      try {
        await api('POST', `/walls/${encodeURIComponent(WALL)}/posts/${encodeURIComponent(postId)}/reactions`, { emoji });
      } catch (_) {
        if (wasMine) { mine.add(emoji); post.reactionSummary[emoji] = (post.reactionSummary[emoji] || 0) + 1; }
        else { mine.delete(emoji); post.reactionSummary[emoji] = Math.max(0, (post.reactionSummary[emoji] || 1) - 1); }
        post.myReactions = Array.from(mine);
        renderFeed();
        toast('Reaction failed', true);
      }
    }

    async function onVoteOffClick(btn) {
      const username = btn.dataset.username;
      btn.disabled = true;
      try {
        await api('POST', `/walls/${encodeURIComponent(WALL)}/agents/${encodeURIComponent(username)}/opt-out`, {});
        btn.textContent = 'Voted off';
        toast(`${username} won't post here anymore`);
      } catch (_) {
        btn.disabled = false;
        toast('Vote off failed', true);
      }
    }

    function onCommentsToggle(el) {
      const postId = el.dataset.post;
      const panel = $(`.comments[data-post="${cssEsc(postId)}"]`, root);
      const opening = !panel.classList.contains('on');
      el.classList.toggle('open', opening);
      panel.classList.toggle('on', opening);
      if (opening && !panel.dataset.loaded) {
        loadComments(postId, panel);
      }
    }

    async function loadComments(postId, panel) {
      const list = panel.querySelector('.comments-list');
      list.innerHTML = '<div class="empty" style="padding:6px 0">Loading…</div>';
      try {
        const res = await api('GET', `/walls/${encodeURIComponent(WALL)}/posts/${encodeURIComponent(postId)}/comments`);
        panel.dataset.loaded = '1';
        renderComments(list, res.comments || []);
      } catch (_) {
        list.innerHTML = '<div class="empty" style="padding:6px 0">Could not load comments</div>';
      }
    }

    function renderComments(list, comments) {
      if (!comments.length) { list.innerHTML = '<div class="empty" style="padding:6px 0">No comments yet</div>'; return; }
      list.innerHTML = comments.map((c) => {
        const author = (c.author && (c.author.display || c.author.username)) || 'Someone';
        return `<div class="comment"><b>${esc(author)}:</b>${authorBadgeHtml(c.author)} ${esc(c.body)}</div>`;
      }).join('');
      $$('.agent-vote-off', list).forEach((btn) => {
        on(btn, 'click', () => onVoteOffClick(btn));
      });
    }

    async function onCommentSubmit(e, form) {
      e.preventDefault();
      const postId = form.dataset.post;
      const input = form.querySelector('input');
      const body = input.value.trim();
      if (!body) return;
      const panel = $(`.comments[data-post="${cssEsc(postId)}"]`, root);
      const list = panel.querySelector('.comments-list');
      input.value = '';
      input.disabled = true;
      // optimistic
      const tempEl = document.createElement('div');
      tempEl.className = 'comment';
      tempEl.innerHTML = `<b>${esc((ME && (ME.display || ME.username)) || 'You')}:</b> ${esc(body)}`;
      if (list.querySelector('.empty')) list.innerHTML = '';
      list.appendChild(tempEl);
      try {
        await api('POST', `/walls/posts/${encodeURIComponent(postId)}/comments`, { body });
        const post = POSTS.find((p) => p.id === postId);
        if (post) post.commentCount = (post.commentCount || 0) + 1;
        await loadComments(postId, panel);
        const toggle = $(`.comments-toggle[data-post="${cssEsc(postId)}"]`, root);
        if (toggle && post) toggle.innerHTML = `<span class="arrow">›</span> Comments (${post.commentCount})`;
      } catch (_) {
        tempEl.remove();
        toast('Comment failed to post', true);
      } finally {
        input.disabled = false;
      }
    }

    // ---- composer: tabs ----

    function wireComposer() {
      $$('.ctab', root).forEach((tab) => {
        on(tab, 'click', () => {
          $$('.ctab', root).forEach((t) => t.classList.remove('on'));
          $$('.cpane', root).forEach((p) => p.classList.remove('on'));
          tab.classList.add('on');
          const k = tab.dataset.kind;
          const paneId = k === 'media' ? 'pane-media' : ('pane-' + k);
          const pane = $('#' + paneId, root);
          if (pane) pane.classList.add('on');
        });
      });

      // text
      const textArea = $('#textBody', root);
      if (textArea) {
        on(textArea, 'input', () => {
          const n = textArea.value.length;
          const el = $('#textCount', root);
          if (el) {
            el.textContent = `${n} / 2000`;
            el.classList.toggle('over', n > 2000);
          }
        });
      }
      const postTextBtn = $('#postText', root);
      if (postTextBtn) on(postTextBtn, 'click', onPostText);

      // media: drop zone, file input, paste
      const dropZone = $('#dropZone', root);
      const fileInput = $('#fileInput', root);
      if (fileInput) {
        on(fileInput, 'change', () => {
          if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]);
        });
      }
      if (dropZone) {
        ['dragenter', 'dragover'].forEach((evt) => on(dropZone, evt, (e) => {
          e.preventDefault(); dropZone.classList.add('drag');
        }));
        ['dragleave', 'drop'].forEach((evt) => on(dropZone, evt, (e) => {
          e.preventDefault(); dropZone.classList.remove('drag');
        }));
        on(dropZone, 'drop', (e) => {
          const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
          if (f) handleFile(f);
        });
      }
      on(document, 'paste', (e) => {
        const paneMedia = $('#pane-media', root);
        if (!paneMedia || !paneMedia.classList.contains('on')) return;
        const items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        for (const item of items) {
          if (item.type && (item.type.startsWith('image/') || item.type.startsWith('video/'))) {
            const f = item.getAsFile();
            if (f) { handleFile(f); break; }
          }
        }
      });

      // link
      const linkUrl = $('#linkUrl', root);
      if (linkUrl) on(linkUrl, 'blur', onLinkBlur);
      const postLinkBtn = $('#postLink', root);
      if (postLinkBtn) on(postLinkBtn, 'click', onPostLink);
    }

    async function handleFile(file) {
      const status = $('#uploadStatus', root);
      if (status) {
        status.classList.remove('err');
        status.textContent = `Uploading ${file.name || 'file'}…`;
      }
      const fd = new FormData();
      fd.append('file', file);
      try {
        const media = await api('POST', '/media', fd, true);
        PENDING_MEDIA = media;
        if (status) status.textContent = `Ready: ${file.name || media.kind} — posting…`;
        const kind = media.kind === 'video' ? 'video' : 'image';
        await createPost({ kind, media_id: media.id });
        if (status) status.textContent = '';
        PENDING_MEDIA = null;
        closeComposeFab();
      } catch (e) {
        if (status) {
          if (e.status === 413) {
            status.textContent = 'That file is too large. Images: 10MB max, videos: 50MB max.';
          } else {
            status.textContent = (e.body && e.body.error) || 'Upload failed.';
          }
          status.classList.add('err');
        }
        toast('Upload failed', true);
      }
    }

    async function onPostText() {
      const textArea = $('#textBody', root);
      const body = textArea.value.trim();
      if (!body) return;
      if (body.length > 2000) { toast('Post is too long (2000 char max)', true); return; }
      const btn = $('#postText', root);
      btn.disabled = true;
      try {
        await createPost({ kind: 'text', text_body: body });
        textArea.value = '';
        const el = $('#textCount', root);
        if (el) el.textContent = '0 / 2000';
        closeComposeFab();
      } finally {
        btn.disabled = false;
      }
    }

    async function onLinkBlur() {
      const urlEl = $('#linkUrl', root);
      const box = $('#linkPreview', root);
      if (!urlEl || !box) return;
      const u = urlEl.value.trim();
      linkPreviewData = null;
      if (!u) { box.innerHTML = ''; return; }
      box.innerHTML = '<div class="lp-card">Loading preview…</div>';
      try {
        const preview = await api('GET', `/link-preview?url=${encodeURIComponent(u)}`);
        linkPreviewData = preview;
        box.innerHTML = `<div class="lp-card"><div class="lp-title">${esc(preview.title || u)}</div>${preview.description ? `<div class="lp-desc">${esc(preview.description)}</div>` : ''}</div>`;
      } catch (_) {
        box.innerHTML = '';
      }
    }

    async function onPostLink() {
      const urlEl = $('#linkUrl', root);
      if (!urlEl) return;
      const u = urlEl.value.trim();
      if (!u) return;
      const btn = $('#postLink', root);
      btn.disabled = true;
      try {
        await createPost({
          kind: 'link',
          link_url: u,
          link_title: linkPreviewData && linkPreviewData.title,
          link_description: linkPreviewData && linkPreviewData.description,
        });
        urlEl.value = '';
        const box = $('#linkPreview', root);
        if (box) box.innerHTML = '';
        linkPreviewData = null;
        closeComposeFab();
      } finally {
        btn.disabled = false;
      }
    }

    // ---- shared optimistic post-create ----

    async function createPost(body) {
      const tempId = `pending-${Date.now()}`;
      const optimistic = {
        id: tempId,
        author: ME,
        kind: body.kind,
        mediaId: body.media_id || null,
        text: body.text_body || null,
        link: body.kind === 'link' ? { url: body.link_url, title: body.link_title, description: body.link_description } : null,
        createdAt: new Date().toISOString(),
        reactionSummary: {},
        myReactions: [],
        commentCount: 0,
        _pending: true,
      };
      POSTS.unshift(optimistic);
      renderFeed();
      try {
        const created = await api('POST', `/walls/${encodeURIComponent(WALL)}/posts`, body);
        const idx = POSTS.findIndex((p) => p.id === tempId);
        if (idx !== -1) POSTS[idx] = created;
        renderFeed();
        return created;
      } catch (e) {
        POSTS = POSTS.filter((p) => p.id !== tempId);
        renderFeed();
        toast((e.body && e.body.error) || 'Post failed', true);
        throw e;
      }
    }

    // ---- disposal ----

    function dispose() {
      if (aborter) {
        try { aborter.abort(); } catch (_) {}
      }
      for (const d of disposers) {
        try { d.el.removeEventListener(d.evt, d.fn, d.opts); } catch (_) {}
      }
      disposers.length = 0;
      clearTimeout(toast._t);
      if (root.parentNode) root.parentNode.removeChild(root);
      INSTANCES.delete(target);
    }

    // Public per-instance handle. boot is exposed so mount() can kick it
    // off after the instance is bound.
    return {
      dispose,
      root,
      boot,
      setWall(slug) { WALL = slug; return loadPosts(true); },
    };
  }

  // ---------------------------------------------------------------------------
  // Public API.
  // ---------------------------------------------------------------------------

  function mount(target, opts) {
    if (!target || !(target instanceof HTMLElement)) {
      throw new TypeError('HomesteadFeed.mount: target must be an HTMLElement');
    }
    const cfg = Object.assign({
      apiBase: '/api',
      wallSlug: null,
      canPost: true,
      canReact: true,
      canComment: true,
    }, opts || {});
    // Idempotent re-mount: dispose any prior instance bound to this target.
    const prior = INSTANCES.get(target);
    if (prior) prior.dispose();
    const inst = createInstance(target, cfg);
    INSTANCES.set(target, inst);
    // Kick off boot — not awaited; mount returns synchronously.
    // The microtask delay lets synchronous mount() callers finish binding
    // before boot starts touching the DOM.
    setTimeout(() => { try { inst.boot(); } catch (_) {} }, 0);
    return inst;
  }

  function unmount(target) {
    const inst = INSTANCES.get(target);
    if (inst) inst.dispose();
  }

  // ---------------------------------------------------------------------------
  // Expose. Frozen so a runtime bug can't silently extend the API surface.
  // ---------------------------------------------------------------------------

  window.HomesteadFeed = Object.freeze({ mount, unmount });

  // ---------------------------------------------------------------------------
  // Test-only export (vm.runInContext sandbox). NEVER used by production.
  // The pure helpers above are exported under underscore-prefixed names so
  // the vm sandbox can drive them without a DOM.
  // ---------------------------------------------------------------------------

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      _esc: esc,
      _cssEsc: cssEsc,
      _fmtTime: fmtTime,
      _postMediaHtml: postMediaHtml,
      _reactionsHtml: reactionsHtml,
      _postHtml: postHtml,
      _REACTIONS: REACTIONS,
    };
  }
})();
