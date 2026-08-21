// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 PHATT Tech LLC

// Homestead — The Porch Wall frontend (PHA-2151).
//
// Vanilla JS, no build step, no framework — same convention as
// public/index.html. Talks to the wall/media routes added in
// PHA-2150/PHA-2149 (lib/walls.js, lib/media.js) plus the
// GET /api/link-preview route added alongside this UI.
'use strict';

(function () {
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));

  const REACTIONS = [
    { emoji: '+1', label: '👍' },
    { emoji: 'joy', label: '😂' },
    { emoji: 'fire', label: '🔥' },
    { emoji: 'eyes', label: '👀' },
    { emoji: 'heart', label: '❤️' },
  ];
  const REACTION_LABEL = REACTIONS.reduce((m, r) => (m[r.emoji] = r.label, m), {});

  let ME = null;
  let WALLS = [];
  let WALL = null; // current slug
  let POSTS = [];
  let CURSOR = null;
  let HAS_MORE = true;
  let PENDING_MEDIA = null; // {id,url,thumbUrl,kind} awaiting post
  let MEMBERS = []; // wall members cache (PHA-2218), refreshed per wall load
  let MEMBER_BY_USERNAME = new Map(); // lowercase username -> member, for mention linkify
  let MUTED_POSTS = new Set(); // local optimistic per-post mute state (no bulk-status endpoint exists)
  let mentionState = null; // {start, end, query} bounds of the in-progress @token in #textBody

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function toast(msg, isErr) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('err', !!isErr);
    el.classList.add('on');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('on'), 3200);
  }

  async function api(method, url, body, isForm) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (body && !isForm) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    } else if (isForm) {
      opts.body = body;
    }
    const r = await fetch(url, opts);
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

  // ---- boot ----
  async function boot() {
    try {
      const me = await api('GET', '/api/me');
      ME = me && me.user;
    } catch (_) { ME = null; }
    if (!ME) {
      window.location.href = '/';
      return;
    }

    let wallsRes;
    try {
      wallsRes = await api('GET', '/api/walls');
    } catch (e) {
      toast('Could not load walls', true);
      return;
    }
    WALLS = (wallsRes && wallsRes.walls) || [];
    if (!WALLS.length) {
      $('#main').innerHTML = '<div class="empty">No walls yet. Ask an admin to add you to one.</div>';
      $('#wallPicker').style.display = 'none';
      return;
    }
    renderWallPicker();
    WALL = WALLS[0].slug;
    $('#wallName').textContent = WALLS[0].name || WALLS[0].slug;
    await Promise.all([loadMembers(), loadNotifyLevel()]);
    await loadPosts(true);

    wireComposer();
    wireOlder();
    wireNotifyLevel();
  }

  function renderWallPicker() {
    const picker = $('#wallPicker');
    if (WALLS.length <= 1) {
      picker.style.display = 'none';
      return;
    }
    picker.innerHTML = WALLS.map((w) => `<option value="${esc(w.slug)}">${esc(w.name || w.slug)}</option>`).join('');
    picker.onchange = async () => {
      WALL = picker.value;
      const w = WALLS.find((x) => x.slug === WALL);
      $('#wallName').textContent = (w && w.name) || WALL;
      MUTED_POSTS = new Set(); // local mute state doesn't carry across walls
      closeMentionMenu();
      await Promise.all([loadMembers(), loadNotifyLevel()]);
      await loadPosts(true);
    };
  }

  // ---- wall members (mention autocomplete + linkify) ----
  async function loadMembers() {
    MEMBERS = [];
    MEMBER_BY_USERNAME = new Map();
    try {
      const res = await api('GET', `/api/walls/${encodeURIComponent(WALL)}/members`);
      MEMBERS = (res && res.members) || [];
      MEMBERS.forEach((m) => MEMBER_BY_USERNAME.set(String(m.username).toLowerCase(), m));
    } catch (e) {
      // autocomplete/mentions just degrade to plain text if this fails
    }
  }

  // ---- per-wall notification level (PHA-2218) ----
  async function loadNotifyLevel() {
    const sel = $('#notifyLevel');
    let level = 'all';
    try {
      const res = await api('GET', `/api/walls/${encodeURIComponent(WALL)}/notifications`);
      level = (res && res.level) || 'all';
    } catch (e) { /* default to 'all' if this fails to load */ }
    sel.value = level;
    sel.dataset.prev = level;
  }

  function wireNotifyLevel() {
    const sel = $('#notifyLevel');
    sel.onchange = async () => {
      const level = sel.value;
      const prev = sel.dataset.prev || 'all';
      try {
        await api('PUT', `/api/walls/${encodeURIComponent(WALL)}/notifications`, { level });
        sel.dataset.prev = level;
      } catch (e) {
        sel.value = prev;
        toast('Could not update notification setting', true);
      }
    };
  }

  // ---- feed ----
  async function loadPosts(reset) {
    if (reset) { POSTS = []; CURSOR = null; HAS_MORE = true; }
    const qs = new URLSearchParams({ limit: '20' });
    if (CURSOR) qs.set('cursor', CURSOR);
    let res;
    try {
      res = await api('GET', `/api/walls/${encodeURIComponent(WALL)}/posts?${qs.toString()}`);
    } catch (e) {
      toast('Could not load posts', true);
      return;
    }
    const page = res.posts || [];
    POSTS = reset ? page : POSTS.concat(page);
    if (page.length) CURSOR = page[page.length - 1].createdAt;
    HAS_MORE = page.length >= 20;
    $('#olderBtn').hidden = !HAS_MORE;
    renderFeed();
  }

  function wireOlder() {
    $('#olderBtn').onclick = () => loadPosts(false);
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
      return `<div class="post-body">${linkifyMentions(esc(p.text), p.id)}</div>`;
    }
    return '';
  }

  // Turns escaped `@handle` tokens into links, but only for handles that
  // match a known wall member (from the /members cache) — this avoids
  // linkifying stray '@' characters (emails, etc.) that aren't real mentions.
  // Plain wall-scoped links (no entity-graph slug resolution) per the design doc.
  function linkifyMentions(escapedText, postId) {
    if (!MEMBER_BY_USERNAME.size) return escapedText;
    return escapedText.replace(/(^|[^\w@])@(\w{1,32})/g, (whole, pre, handle) => {
      const m = MEMBER_BY_USERNAME.get(handle.toLowerCase());
      if (!m) return whole;
      const href = `/porch.html?wall=${encodeURIComponent(WALL)}&post=${encodeURIComponent(postId)}#${encodeURIComponent(m.username)}`;
      return `${pre}<a href="${href}" class="mention-link">@${esc(m.username)}</a>`;
    });
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

  function postHtml(p) {
    const author = (p.author && (p.author.display || p.author.username)) || 'Someone';
    return `<div class="post${p._pending ? ' pending' : ''}" data-id="${esc(p.id)}">
      <div class="post-head">
        <div class="post-author">${esc(author)}</div>
        <div class="post-time">${esc(fmtTime(p.createdAt))}</div>
      </div>
      ${postMediaHtml(p)}
      ${reactionsHtml(p)}
      <div class="post-tools">
        <div class="comments-toggle" data-post="${esc(p.id)}">
          <span class="arrow">›</span> Comments${p.commentCount ? ` (${p.commentCount})` : ''}
        </div>
        ${muteBtnHtml(p)}
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

  // Thread mute toggle (PHA-2218). No bulk "am I muting any of these posts"
  // endpoint exists, so this starts every post in the "not muted" visual
  // state and flips optimistically per click — acceptable v1.
  function muteBtnHtml(p) {
    const muted = MUTED_POSTS.has(p.id);
    const label = muted ? 'Unmute this thread' : 'Mute this thread';
    return `<button type="button" class="mute-btn${muted ? ' muted' : ''}" data-post="${esc(p.id)}" aria-label="${esc(label)}" title="${esc(label)}">${muted ? '🔕' : '🔔'}</button>`;
  }

  function renderFeed() {
    const feed = $('#feed');
    if (!POSTS.length) {
      feed.innerHTML = '<div class="empty">No posts yet. Be the first!</div>';
      return;
    }
    feed.innerHTML = POSTS.map(postHtml).join('');
    wireFeedEvents();
  }

  function wireFeedEvents() {
    $$('.reaction').forEach((btn) => { btn.onclick = debounce(() => onReactClick(btn), 300); });
    $$('.comments-toggle').forEach((el) => { el.onclick = () => onCommentsToggle(el); });
    $$('.comment-form').forEach((f) => { f.onsubmit = (e) => onCommentSubmit(e, f); });
    $$('.mute-btn').forEach((btn) => { btn.onclick = debounce(() => onMuteClick(btn), 300); });
  }

  async function onMuteClick(btn) {
    const postId = btn.dataset.post;
    const wasMuted = MUTED_POSTS.has(postId);
    const nextMuted = !wasMuted;
    const setBtnState = (muted) => {
      const label = muted ? 'Unmute this thread' : 'Mute this thread';
      btn.classList.toggle('muted', muted);
      btn.textContent = muted ? '🔕' : '🔔';
      btn.setAttribute('aria-label', label);
      btn.title = label;
    };
    // optimistic
    if (nextMuted) MUTED_POSTS.add(postId); else MUTED_POSTS.delete(postId);
    setBtnState(nextMuted);
    try {
      if (nextMuted) {
        await api('POST', `/api/walls/${encodeURIComponent(WALL)}/posts/${encodeURIComponent(postId)}/mute`);
      } else {
        await api('DELETE', `/api/walls/${encodeURIComponent(WALL)}/posts/${encodeURIComponent(postId)}/mute`);
      }
    } catch (e) {
      // rollback
      if (nextMuted) MUTED_POSTS.delete(postId); else MUTED_POSTS.add(postId);
      setBtnState(wasMuted);
      toast('Could not update mute setting', true);
    }
  }

  function debounce(fn, ms) {
    let busy = false;
    return (...args) => {
      if (busy) return;
      busy = true;
      Promise.resolve(fn(...args)).finally(() => setTimeout(() => { busy = false; }, ms));
    };
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
      await api('POST', `/api/walls/${encodeURIComponent(WALL)}/posts/${encodeURIComponent(postId)}/reactions`, { emoji });
    } catch (e) {
      // rollback
      if (wasMine) { mine.add(emoji); post.reactionSummary[emoji] = (post.reactionSummary[emoji] || 0) + 1; }
      else { mine.delete(emoji); post.reactionSummary[emoji] = Math.max(0, (post.reactionSummary[emoji] || 1) - 1); }
      post.myReactions = Array.from(mine);
      renderFeed();
      toast('Reaction failed', true);
    }
  }

  function onCommentsToggle(el) {
    const postId = el.dataset.post;
    const panel = $(`.comments[data-post="${cssEsc(postId)}"]`);
    const opening = !panel.classList.contains('on');
    el.classList.toggle('open', opening);
    panel.classList.toggle('on', opening);
    if (opening && !panel.dataset.loaded) {
      loadComments(postId, panel);
    }
  }

  function cssEsc(s) {
    return String(s).replace(/["\\]/g, '\\$&');
  }

  async function loadComments(postId, panel) {
    const list = panel.querySelector('.comments-list');
    list.innerHTML = '<div class="empty" style="padding:6px 0">Loading…</div>';
    try {
      const res = await api('GET', `/api/walls/${encodeURIComponent(WALL)}/posts/${encodeURIComponent(postId)}/comments`);
      panel.dataset.loaded = '1';
      renderComments(list, res.comments || [], postId);
    } catch (e) {
      list.innerHTML = '<div class="empty" style="padding:6px 0">Could not load comments</div>';
    }
  }

  function renderComments(list, comments, postId) {
    if (!comments.length) { list.innerHTML = '<div class="empty" style="padding:6px 0">No comments yet</div>'; return; }
    list.innerHTML = comments.map((c) => {
      const author = (c.author && (c.author.display || c.author.username)) || 'Someone';
      return `<div class="comment"><b>${esc(author)}:</b> ${linkifyMentions(esc(c.body), postId)}</div>`;
    }).join('');
  }

  async function onCommentSubmit(e, form) {
    e.preventDefault();
    const postId = form.dataset.post;
    const input = form.querySelector('input');
    const body = input.value.trim();
    if (!body) return;
    const panel = $(`.comments[data-post="${cssEsc(postId)}"]`);
    const list = panel.querySelector('.comments-list');
    input.value = '';
    input.disabled = true;
    // optimistic
    const tempEl = document.createElement('div');
    tempEl.className = 'comment';
    tempEl.innerHTML = `<b>${esc((ME && (ME.display || ME.username)) || 'You')}:</b> ${linkifyMentions(esc(body), postId)}`;
    if (list.querySelector('.empty')) list.innerHTML = '';
    list.appendChild(tempEl);
    try {
      await api('POST', `/api/walls/posts/${encodeURIComponent(postId)}/comments`, { body });
      const post = POSTS.find((p) => p.id === postId);
      if (post) post.commentCount = (post.commentCount || 0) + 1;
      await loadComments(postId, panel);
      const toggle = $(`.comments-toggle[data-post="${cssEsc(postId)}"]`);
      if (toggle && post) toggle.innerHTML = `<span class="arrow">›</span> Comments (${post.commentCount})`;
    } catch (e) {
      tempEl.remove();
      toast('Comment failed to post', true);
    } finally {
      input.disabled = false;
    }
  }

  // ---- composer: tabs ----
  function wireComposer() {
    $$('.ctab').forEach((tab) => {
      tab.onclick = () => {
        $$('.ctab').forEach((t) => t.classList.remove('on'));
        $$('.cpane').forEach((p) => p.classList.remove('on'));
        tab.classList.add('on');
        $(`#pane-${tab.dataset.kind === 'media' ? 'media' : tab.dataset.kind}`).classList.add('on');
      };
    });

    // text
    const textArea = $('#textBody');
    textArea.addEventListener('input', () => {
      const n = textArea.value.length;
      const el = $('#textCount');
      el.textContent = `${n} / 2000`;
      el.classList.toggle('over', n > 2000);
      updateMentionMenu(textArea);
    });
    textArea.addEventListener('keydown', onMentionKeydown);
    textArea.addEventListener('blur', () => {
      // delay so a mousedown on a dropdown item can register its selection first
      setTimeout(closeMentionMenu, 150);
    });
    $('#postText').onclick = onPostText;

    // media: drop zone, file input, paste
    const dropZone = $('#dropZone');
    const fileInput = $('#fileInput');
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]);
    });
    ['dragenter', 'dragover'].forEach((evt) => dropZone.addEventListener(evt, (e) => {
      e.preventDefault(); dropZone.classList.add('drag');
    }));
    ['dragleave', 'drop'].forEach((evt) => dropZone.addEventListener(evt, (e) => {
      e.preventDefault(); dropZone.classList.remove('drag');
    }));
    dropZone.addEventListener('drop', (e) => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f);
    });
    document.addEventListener('paste', (e) => {
      if (!$('#pane-media').classList.contains('on')) return;
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
    $('#linkUrl').addEventListener('blur', onLinkBlur);
    $('#postLink').onclick = onPostLink;
  }

  // ---- composer: @mention autocomplete ----
  function currentMentionToken(textArea) {
    const pos = textArea.selectionStart;
    const upToCursor = textArea.value.slice(0, pos);
    const m = upToCursor.match(/(?:^|\s)@(\w{0,32})$/);
    if (!m) return null;
    const start = pos - m[1].length - 1; // index of the '@'
    return { start, end: pos, query: m[1] };
  }

  function updateMentionMenu(textArea) {
    const token = currentMentionToken(textArea);
    if (!token || !MEMBERS.length) { closeMentionMenu(); return; }
    const q = token.query.toLowerCase();
    const matches = MEMBERS.filter((m) =>
      String(m.username).toLowerCase().startsWith(q) || String(m.display || '').toLowerCase().startsWith(q)
    ).slice(0, 8);
    if (!matches.length) { closeMentionMenu(); return; }
    mentionState = token;
    renderMentionMenu(matches);
  }

  function renderMentionMenu(matches) {
    const menu = $('#mentionMenu');
    menu.innerHTML = matches.map((m, i) => `<div class="mention-item${i === 0 ? ' active' : ''}" data-username="${esc(m.username)}">
      <span class="mu">@${esc(m.username)}</span>${m.display && m.display !== m.username ? `<span class="md">${esc(m.display)}</span>` : ''}
    </div>`).join('');
    menu.classList.add('on');
    $$('.mention-item', menu).forEach((item) => {
      // mousedown (not click) + preventDefault so the textarea never loses
      // focus/blurs before the selection is applied.
      item.onmousedown = (e) => { e.preventDefault(); selectMention(item.dataset.username); };
    });
  }

  function closeMentionMenu() {
    mentionState = null;
    const menu = $('#mentionMenu');
    if (!menu) return;
    menu.classList.remove('on');
    menu.innerHTML = '';
  }

  function selectMention(username) {
    if (!mentionState) return;
    const textArea = $('#textBody');
    const { start, end } = mentionState;
    const value = textArea.value;
    const insert = `@${username} `;
    textArea.value = value.slice(0, start) + insert + value.slice(end);
    const caret = start + insert.length;
    closeMentionMenu();
    textArea.focus();
    textArea.setSelectionRange(caret, caret);
    const n = textArea.value.length;
    const el = $('#textCount');
    el.textContent = `${n} / 2000`;
    el.classList.toggle('over', n > 2000);
  }

  function onMentionKeydown(e) {
    const menu = $('#mentionMenu');
    if (!menu.classList.contains('on')) return;
    const items = $$('.mention-item', menu);
    if (!items.length) return;
    let idx = items.findIndex((it) => it.classList.contains('active'));
    if (idx === -1) idx = 0;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[idx].classList.remove('active');
      idx = (idx + 1) % items.length;
      items[idx].classList.add('active');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[idx].classList.remove('active');
      idx = (idx - 1 + items.length) % items.length;
      items[idx].classList.add('active');
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      selectMention(items[idx].dataset.username);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeMentionMenu();
    }
  }

  async function handleFile(file) {
    const status = $('#uploadStatus');
    status.classList.remove('err');
    status.textContent = `Uploading ${file.name || 'file'}…`;
    const fd = new FormData();
    fd.append('file', file);
    try {
      const media = await api('POST', '/api/media', fd, true);
      PENDING_MEDIA = media;
      status.textContent = `Ready: ${file.name || media.kind} — posting…`;
      const kind = media.kind === 'video' ? 'video' : 'image';
      await createPost({ kind, media_id: media.id });
      status.textContent = '';
      PENDING_MEDIA = null;
    } catch (e) {
      if (e.status === 413) {
        status.textContent = 'That file is too large. Images: 10MB max, videos: 50MB max.';
      } else {
        status.textContent = (e.body && e.body.error) || 'Upload failed.';
      }
      status.classList.add('err');
      toast('Upload failed', true);
    }
  }

  async function onPostText() {
    const textArea = $('#textBody');
    const body = textArea.value.trim();
    if (!body) return;
    if (body.length > 2000) { toast('Post is too long (2000 char max)', true); return; }
    const btn = $('#postText');
    btn.disabled = true;
    try {
      await createPost({ kind: 'text', text_body: body });
      textArea.value = '';
      $('#textCount').textContent = '0 / 2000';
    } finally {
      btn.disabled = false;
    }
  }

  let linkPreviewData = null;
  async function onLinkBlur() {
    const url = $('#linkUrl').value.trim();
    const box = $('#linkPreview');
    linkPreviewData = null;
    if (!url) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="lp-card">Loading preview…</div>';
    try {
      const preview = await api('GET', `/api/link-preview?url=${encodeURIComponent(url)}`);
      linkPreviewData = preview;
      box.innerHTML = `<div class="lp-card"><div class="lp-title">${esc(preview.title || url)}</div>${preview.description ? `<div class="lp-desc">${esc(preview.description)}</div>` : ''}</div>`;
    } catch (e) {
      box.innerHTML = '';
    }
  }

  async function onPostLink() {
    const url = $('#linkUrl').value.trim();
    if (!url) return;
    const btn = $('#postLink');
    btn.disabled = true;
    try {
      await createPost({
        kind: 'link',
        link_url: url,
        link_title: linkPreviewData && linkPreviewData.title,
        link_description: linkPreviewData && linkPreviewData.description,
      });
      $('#linkUrl').value = '';
      $('#linkPreview').innerHTML = '';
      linkPreviewData = null;
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
      const created = await api('POST', `/api/walls/${encodeURIComponent(WALL)}/posts`, body);
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

  boot();
})();
