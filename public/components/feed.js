// Homestead — Wall feed/composer/reactions component.
// Vanilla JS, no framework, no build step. Extracted from porch.js
// (PHA-2200.5/PHA-2206/PHA-2151). Mounted by both /porch.html and
// /index.html's #page-wall; same component in both placements.
//
// API:
//   HomesteadFeed.mount(target, opts) -> { dispose, setWall, root }
//   HomesteadFeed.unmount(target)
//     opts: { apiBase='/api', wallSlug=null, canPost=true, canReact=true, canComment=true }
// Idempotent re-mount: prior instance on the same target is disposed first.

'use strict';

(function () {
  const REACTIONS = Object.freeze([
    Object.freeze({ emoji: '+1',    label: '👍' }),
    Object.freeze({ emoji: 'joy',   label: '😂' }),
    Object.freeze({ emoji: 'fire',  label: '🔥' }),
    Object.freeze({ emoji: 'eyes',  label: '👀' }),
    Object.freeze({ emoji: 'heart', label: '❤️' }),
  ]);

  // WeakMap so disposing the target element doesn't leak memory.
  const INSTANCES = new WeakMap();

  // Pure helpers — no DOM, reusable across instances + tests.

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
    const d = new Date(String(iso || '').replace(' ', 'T') + 'Z');
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function postMediaHtml(p) {
    const url = p.mediaId ? `/api/media/${p.mediaId}` : '';
    if (p.kind === 'image') return `<div class="post-media"><img src="${esc(url)}" loading="lazy" alt=""></div>`;
    if (p.kind === 'video') return `<div class="post-media"><video src="${esc(url)}" controls preload="metadata"></video></div>`;
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

  // PHA-2647: agent badge + vote-off. PHA-2827.D: Hearth ('built-in') gets its own label.
  function agentBadgeHtml(kind) {
    if (kind === 'built-in') {
      return `<span class="agent-badge" title="Hearth — the house's built-in agent">[hearth]</span>`;
    }
    return `<span class="agent-badge" title="Posted by an agent, not a household member">[agent]</span>`;
  }

  function voteOffHtml(username) {
    return `<button type="button" class="vote-off" data-username="${esc(username)}">Vote off the porch</button>`;
  }

  function postHtml(p, isAdmin, meUsername) {
    const isAgent = !!(p.author && p.author.isAgent);
    const author = (p.author && (p.author.display || p.author.username)) || 'Someone';
    const username = (p.author && p.author.username) || '';
    const isMine = !!(meUsername && p.author && p.author.username === meUsername);
    const deleteHtml = isMine
      ? `<button type="button" class="post-delete" data-post="${esc(p.id)}" title="Delete post" aria-label="Delete post">🗑</button>`
      : '';
    return `<div class="post${p._pending ? ' pending' : ''}${isAgent ? ' agent-post' : ''}" data-id="${esc(p.id)}">
      <div class="post-head">
        <div class="post-author">${esc(author)}${isAgent ? agentBadgeHtml(p.author && p.author.kind) : ''}</div>
        <div class="post-head-right">
          <div class="post-time">${esc(fmtTime(p.createdAt))}</div>
          ${deleteHtml}
        </div>
      </div>
      ${postMediaHtml(p)}
      ${reactionsHtml(p)}
      ${isAgent && isAdmin ? `<div class="post-tools">${voteOffHtml(username)}</div>` : ''}
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

  // Per-instance factory — each instance owns its own state, DOM refs scoped
  // via `.feed-root`, and a disposers list for cleanup.

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

    // ---- live updates (PHA-2821): one EventSource per mounted wall.
    let sse = null;
    let sseErrorStreak = 0;
    let sseGaveUp = false;
    const SSE_GIVE_UP_THRESHOLD = 4;

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

      // PHA-2727: centered FAB + util chip. Both opt-in via cfg so the index.html
      // mount (which has its own chrome) is unaffected.
      const utilChipHtml = cfg.utilityChip ? `<button type="button" id="utilChip" class="util-chip" aria-label="Profile and settings">⋯</button>` : '';
      const composerWrapOpen = cfg.primaryFab ? '' : ' on';
      // PHA-2822: starting-room pill. Caller passes addRoomPill (porch.html).
      const addRoomPillHtml = cfg.addRoomPill ? `<a href="/modules.html" id="addRoomPill" class="add-room-pill">+ Add a room</a>` : '';

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
  ${addRoomPillHtml}
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
      // Render the static shell before the first network round-trip so the user
      // sees a populated UI immediately (Playwright `state: 'visible'` selectors
      // fire even on slow networks). PHA-2206 regression: boot() previously
      // forgot to call renderShell().
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
      wireNotifyLevel();
      await refreshNotifyLevel();
      await loadPosts(true);

      if (cfg.canPost) wireComposer();
      wireOlder();
      if (cfg.primaryFab) wireComposeFab();
      if (cfg.utilityChip) wireUtilChip();

      connectLive();
      on(document, 'visibilitychange', onVisibilityChange);
    }

    // Reactions omitted: broadcasting needs a per-viewer myReactions diff.
    function connectLive() {
      closeLive();
      if (!WALL || document.hidden) return;
      sseGaveUp = false;
      sse = new EventSource(url(`/walls/${encodeURIComponent(WALL)}/events`));
      sse.addEventListener('post', (e) => {
        sseErrorStreak = 0;
        let post;
        try { post = JSON.parse(e.data); } catch (_) { return; }
        if (!post || POSTS.some((p) => p.id === post.id)) return;
        POSTS.unshift(post);
        renderFeed();
      });
      sse.addEventListener('comment', (e) => {
        sseErrorStreak = 0;
        let comment;
        try { comment = JSON.parse(e.data); } catch (_) { return; }
        if (!comment || !comment.postId) return;
        const post = POSTS.find((p) => p.id === comment.postId);
        if (!post) return;
        post.commentCount = (post.commentCount || 0) + 1;
        const toggle = $(`.comments-toggle[data-post="${cssEsc(post.id)}"]`, root);
        if (toggle) toggle.innerHTML = `<span class="arrow">›</span> Comments (${post.commentCount})`;
        const panel = $(`.comments[data-post="${cssEsc(post.id)}"]`, root);
        if (panel && panel.classList.contains('on')) loadComments(post.id, panel);
      });
      sse.onerror = () => {
        sseErrorStreak += 1;
        if (sseErrorStreak >= SSE_GIVE_UP_THRESHOLD && !sseGaveUp) {
          sseGaveUp = true;
          closeLive();
        }
      };
    }

    function closeLive() {
      if (sse) { try { sse.close(); } catch (_) {} sse = null; }
    }

    function onVisibilityChange() {
      if (document.hidden) {
        closeLive();
        return;
      }
      if (sseGaveUp) loadPosts(true);
      connectLive();
    }

    // PHA-2727: centered FAB toggles the composer card. Closes after a successful post.
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

    // PHA-2727: standalone porch shell needed a profile/settings entry point.
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
        await refreshNotifyLevel();
        connectLive();
      });
    }

    // PHA-2656: notify-level dropdown wired to GET/PUT /api/walls/:slug/notifications.

    async function refreshNotifyLevel() {
      const sel = $('#notifyLevel', root);
      if (!sel || !WALL) return;
      try {
        const res = await api('GET', `/walls/${encodeURIComponent(WALL)}/notifications`);
        const level = (res && res.level) || 'all';
        sel.value = level;
        sel.dataset.prev = level;
      } catch (_) {
        // Non-fatal: leave the select at its current value so the user
        // can still try to change it.
      }
    }

    function wireNotifyLevel() {
      const sel = $('#notifyLevel', root);
      if (!sel) return;
      on(sel, 'change', async () => {
        const level = sel.value;
        const prev = sel.dataset.prev || 'all';
        sel.disabled = true;
        try {
          await api('PUT', `/walls/${encodeURIComponent(WALL)}/notifications`, { level });
          sel.dataset.prev = level;
        } catch (_) {
          sel.value = prev;
          toast('Could not save notification setting', true);
        } finally {
          sel.disabled = false;
        }
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
      const isAdmin = !!(ME && ME.isAdmin);
      feed.innerHTML = POSTS.map((p) => postHtml(p, isAdmin, ME && ME.username)).join('');
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
      $$('.post-delete', root).forEach((btn) => {
        on(btn, 'click', () => onDeleteClick(btn));
      });
      if (cfg.canComment) {
        $$('.comment-form', root).forEach((f) => {
          on(f, 'submit', (e) => onCommentSubmit(e, f));
        });
      } else {
        $$('.comment-form', root).forEach((f) => { f.style.display = 'none'; });
      }
      wireVoteOffButtons(root);
    }

    // PHA-2647: wired after renderFeed() + each renderComments() re-render.
    function wireVoteOffButtons(scopeEl) {
      Array.from((scopeEl || root).querySelectorAll('.vote-off')).forEach((btn) => {
        on(btn, 'click', () => onVoteOffClick(btn));
      });
    }

    // PHA-2647: reversible per-wall opt-out.
    async function onVoteOffClick(btn) {
      const username = btn.dataset.username;
      if (!username) return;
      if (!window.confirm(`Hide ${username} from this wall?`)) return;
      btn.disabled = true;
      try {
        await api('POST', `/walls/${encodeURIComponent(WALL)}/agents/${encodeURIComponent(username)}/opt-out`, {});
        toast(`${username} hidden from this wall`);
        await loadPosts(true);
      } catch (e) {
        btn.disabled = false;
        toast((e.body && e.body.error) || 'Could not hide agent', true);
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

    async function onDeleteClick(btn) {
      const postId = btn.dataset.post;
      if (!confirm('Delete this post? This cannot be undone.')) return;
      btn.disabled = true;
      try {
        await api('DELETE', `/walls/${encodeURIComponent(WALL)}/posts/${encodeURIComponent(postId)}`);
        POSTS = POSTS.filter((p) => p.id !== postId);
        renderFeed();
        toast('Post deleted');
      } catch (_) {
        btn.disabled = false;
        toast('Delete failed', true);
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
      const isAdmin = !!(ME && ME.isAdmin);
      list.innerHTML = comments.map((c) => {
        const isAgent = !!(c.author && c.author.isAgent);
        const author = (c.author && (c.author.display || c.author.username)) || 'Someone';
        const username = (c.author && c.author.username) || '';
        return `<div class="comment${isAgent ? ' agent-comment' : ''}"><b>${esc(author)}</b>${isAgent ? agentBadgeHtml(c.author && c.author.kind) : ''}: ${esc(c.body)}${isAgent && isAdmin ? ` ${voteOffHtml(username)}` : ''}</div>`;
      }).join('');
      wireVoteOffButtons(list);
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
        // SSE for this same post can land first and insert `created.id` already;
        // drop that copy so replacing the optimistic placeholder doesn't double it.
        POSTS = POSTS.filter((p) => p.id !== created.id);
        const idx = POSTS.findIndex((p) => p.id === tempId);
        if (idx !== -1) POSTS[idx] = created;
        else POSTS.unshift(created);
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
      closeLive();
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

    return {
      dispose,
      root,
      boot,
      setWall(slug) { WALL = slug; connectLive(); return loadPosts(true); },
    };
  }

  // Public API.

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
    const prior = INSTANCES.get(target);
    if (prior) prior.dispose();
    const inst = createInstance(target, cfg);
    INSTANCES.set(target, inst);
    // setTimeout(0) defers boot so synchronous mount() callers finish binding
    // before boot starts touching the DOM.
    setTimeout(() => { try { inst.boot(); } catch (_) {} }, 0);
    return inst;
  }

  function unmount(target) {
    const inst = INSTANCES.get(target);
    if (inst) inst.dispose();
  }

  // Frozen so a runtime bug can't silently extend the API surface.
  window.HomesteadFeed = Object.freeze({ mount, unmount });

  // Test-only export (vm.runInContext). NEVER used in production.
  // Pure helpers exposed under underscore-prefixed names for sandbox tests.

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      _esc: esc,
      _cssEsc: cssEsc,
      _fmtTime: fmtTime,
      _postMediaHtml: postMediaHtml,
      _reactionsHtml: reactionsHtml,
      _postHtml: postHtml,
      _agentBadgeHtml: agentBadgeHtml,
      _voteOffHtml: voteOffHtml,
      _REACTIONS: REACTIONS,
    };
  }
})();
