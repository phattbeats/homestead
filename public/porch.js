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
    await loadPosts(true);

    wireComposer();
    wireOlder();
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
      await loadPosts(true);
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

  function postHtml(p) {
    const author = (p.author && (p.author.display || p.author.username)) || 'Someone';
    return `<div class="post${p._pending ? ' pending' : ''}" data-id="${esc(p.id)}">
      <div class="post-head">
        <div class="post-author">${esc(author)}</div>
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
      renderComments(list, res.comments || []);
    } catch (e) {
      list.innerHTML = '<div class="empty" style="padding:6px 0">Could not load comments</div>';
    }
  }

  function renderComments(list, comments) {
    if (!comments.length) { list.innerHTML = '<div class="empty" style="padding:6px 0">No comments yet</div>'; return; }
    list.innerHTML = comments.map((c) => {
      const author = (c.author && (c.author.display || c.author.username)) || 'Someone';
      return `<div class="comment"><b>${esc(author)}:</b> ${esc(c.body)}</div>`;
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
    tempEl.innerHTML = `<b>${esc((ME && (ME.display || ME.username)) || 'You')}:</b> ${esc(body)}`;
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
