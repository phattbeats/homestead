/* The Forum — one markup, three skins.
 *
 * Renders the index, board, thread and member-list views into #forum.
 * Every skin gets the same DOM; public/forum/skin-*.css decide what it
 * looks like and which decorative slots (marquee, hit counter, rank
 * stars, top posters, button badges) are visible. Nothing in here
 * branches on the skin except the chooser itself.
 *
 * Boards are walls, threads are wall posts, replies are post comments:
 * reads come from /api/forum/*, writes go through the existing
 * /api/walls/* routes so notifications and live events keep working.
 *
 * Routing is the query string, same as the old /porch.html deep links:
 *   /forum                 index
 *   /forum?wall=<slug>     board (thread list), &page=N
 *   /forum?post=<id>       thread
 *   /forum?view=members    member list
 */
(function () {
  'use strict';

  var SKINS = [
    { key: 'woodgrain', label: 'Woodgrain' },
    { key: 'classic', label: 'Classic' },
    { key: 'clubhouse', label: 'Night Owl' },
  ];
  var SKIN_KEYS = SKINS.map(function (s) { return s.key; });
  var SKIN_STORE = 'homestead.forumSkin';
  var COLLAPSE_STORE = 'homestead.forumCollapsed';
  var BOARD_ICONS = { announcements: '📰', household: '🪑', introductions: '👋' };
  var REACTIONS = [
    { key: '+1', emoji: '👍', label: 'Thanks' },
    { key: 'joy', emoji: '😂' },
    { key: 'fire', emoji: '🔥' },
    { key: 'eyes', emoji: '👀' },
    { key: 'heart', emoji: '❤️' },
  ];
  var SMILIES = ['😀', '😂', '🔥', '👀', '❤️', '👍', '😎', '🙃'];
  var RANK_STARS = { 'Newcomer': 1, 'Junior Member': 2, 'Member': 3, 'Senior Member': 4, 'Elite Member': 5, 'Administrator': 5 };
  var HOT_REPLIES = 10;

  var root = document.getElementById('forum');
  var state = { me: null, profile: null, stats: null, online: null };

  // ---------- helpers ----------

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api(method, url, body) {
    return fetch(url, {
      method: method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || ('http_' + r.status)); e.status = r.status; throw e; }
        return j;
      });
    });
  }
  function store(key, val) {
    try { if (val === undefined) return localStorage.getItem(key); localStorage.setItem(key, val); } catch (_) { /* private mode */ }
    return null;
  }
  // SQLite datetime('now') is UTC without a zone marker.
  function parseTs(ts) {
    if (!ts) return null;
    var iso = /[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : ts.replace(' ', 'T') + 'Z';
    var d = new Date(iso);
    return isNaN(d) ? null : d;
  }
  function clock(d) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  function ordinal(n) {
    var s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function when(ts) {
    var d = parseTs(ts);
    if (!d) return '';
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var day = new Date(d); day.setHours(0, 0, 0, 0);
    var diff = Math.round((today - day) / 86400000);
    if (diff === 0) return 'Today, ' + clock(d);
    if (diff === 1) return 'Yesterday, ' + clock(d);
    return d.toLocaleDateString([], { month: 'short' }) + ' ' + ordinal(d.getDate()) + ', ' + d.getFullYear();
  }
  function joined(ts) {
    var d = parseTs(ts);
    return d ? d.toLocaleDateString([], { month: 'short', year: 'numeric' }) : '';
  }
  function num(n) { return Number(n || 0).toLocaleString(); }
  function href(params) {
    var q = Object.keys(params || {}).filter(function (k) { return params[k] != null; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
    return '/forum' + (q ? '?' + q : '');
  }
  function link(params, text, cls) {
    return '<a href="' + esc(href(params)) + '" data-nav' + (cls ? ' class="' + cls + '"' : '') + '>' + text + '</a>';
  }
  // Role colouring shared by every name on the page.
  function who(u, opts) {
    if (!u) return '<span class="fx-user">someone</span>';
    var cls = 'fx-user';
    if (u.isAgent) cls += ' fx-bot';
    else if (u.rank === 'Administrator' || u.isAdmin) cls += ' fx-adm';
    var label = esc(u.display || u.username);
    return opts && opts.plain ? '<span class="' + cls + '">' + label + '</span>'
      : '<span class="' + cls + '" data-username="' + esc(u.username) + '">' + label + '</span>';
  }
  function stars(rank, isAgent) {
    if (isAgent) return '<span class="fx-stars" aria-hidden="true">🤖</span>';
    var n = RANK_STARS[rank] || 1;
    return '<span class="fx-stars" aria-label="' + n + ' of 5 stars">' + '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n) + '</span>';
  }
  function avatar(m) {
    var name = (m && (m.display || m.username)) || '?';
    var color = (m && m.color) || '#6D7B59';
    if (m && m.isAgent) return '<div class="fx-ava" aria-hidden="true">🔥</div>';
    return '<div class="fx-ava" aria-hidden="true" style="--ava:' + esc(color) + '"><span>' + esc(name.charAt(0).toUpperCase()) + '</span></div>';
  }
  // Plain text in, safe HTML out. Lines starting with "> " become a quote
  // block; a first quote line ending "wrote:" is its attribution.
  function body(text) {
    var out = [], quote = null;
    String(text || '').split('\n').forEach(function (line) {
      if (/^>\s?/.test(line)) { (quote = quote || []).push(line.replace(/^>\s?/, '')); return; }
      if (quote) { out.push(renderQuote(quote)); quote = null; }
      out.push(esc(line) + '<br>');
    });
    if (quote) out.push(renderQuote(quote));
    return out.join('').replace(/(<br>)+$/, '');
  }
  function renderQuote(lines) {
    var head = /wrote:$/.test(lines[0]) ? '<b>' + esc(lines.shift()) + '</b>' : '';
    return '<blockquote class="fx-quote">' + head + lines.map(esc).join('<br>') + '</blockquote>';
  }

  // ---------- skins ----------

  function applySkin(skin) {
    if (SKIN_KEYS.indexOf(skin) === -1) skin = 'woodgrain';
    store(SKIN_STORE, skin);
    var html = document.documentElement;
    var current = document.getElementById('forumSkin');
    if (html.getAttribute('data-skin') === skin && current) return;
    // Load the new sheet before dropping the old one, so the swap
    // doesn't flash an unstyled page.
    var next = document.createElement('link');
    next.rel = 'stylesheet';
    next.href = '/forum/skin-' + skin + '.css';
    next.onload = function () {
      html.setAttribute('data-skin', skin);
      if (current && current.parentNode) current.parentNode.removeChild(current);
      next.id = 'forumSkin';
    };
    document.head.appendChild(next);
    document.querySelectorAll('select[data-skin-chooser]').forEach(function (s) { s.value = skin; });
    var label = document.getElementById('fxSkinName');
    if (label) label.textContent = skinLabel(skin);
  }
  function skinLabel(key) {
    for (var i = 0; i < SKINS.length; i++) if (SKINS[i].key === key) return SKINS[i].label;
    return key;
  }
  function chooser(id) {
    return '<select id="' + id + '" data-skin-chooser aria-label="Forum style">' + SKINS.map(function (s) {
      return '<option value="' + s.key + '"' + (s.key === currentSkin() ? ' selected' : '') + '>' + esc(s.label) + '</option>';
    }).join('') + '</select>';
  }
  function currentSkin() { return document.documentElement.getAttribute('data-skin') || 'woodgrain'; }
  function setSkin(skin) {
    applySkin(skin);
    if (state.profile) state.profile.forumSkin = skin;
    return api('PATCH', '/api/forum/me', { forum_skin: skin }).catch(function () { /* localStorage still has it */ });
  }

  // ---------- chrome ----------

  function chrome(active) {
    var me = state.me.user;
    var p = state.profile || {};
    var stats = state.stats || {};
    var name = me.display || me.username;
    var visited = p.lastVisitAt ? when(p.lastVisitAt) : null;
    var marquee = ['WELCOME BACK ' + name.toUpperCase() + '!!'];
    (stats.birthdaysToday || []).forEach(function (b) { marquee.push('happy birthday ' + (b.display || b.username) + '!!! 🎂'); });
    if (state.online) marquee.push(state.online.count + ' online right now');
    if (stats.newestMember) marquee.push('say hi to our newest member ' + (stats.newestMember.display || stats.newestMember.username));
    var tabs = [
      { key: 'forum', href: '/forum', label: 'Forum', icon: '🏠' },
      { key: 'news', href: '/gazette.html', label: 'Gazette', icon: '📰' },
      { key: 'rooms', href: '/modules.html', label: 'Rooms', icon: '🚪' },
      { key: 'invites', href: '/invites.html', label: 'Invites', icon: '✉️' },
      { key: 'members', href: href({ view: 'members' }), label: 'Members', icon: '👥', nav: true },
    ];
    return '' +
      '<header class="fx-header">' +
        '<a class="fx-logo" href="/forum" data-nav aria-label="The Forum home"><span class="fx-door"></span><span class="fx-mono">H</span></a>' +
        '<div class="fx-title">' +
          '<div class="fx-name"><span class="fx-v fx-v-woodgrain">The Forum</span><span class="fx-v fx-v-classic">The Forum @ Homestead</span><span class="fx-v fx-v-clubhouse">~*~ ThE FoRuM ~*~</span></div>' +
          '<div class="fx-tag"><span class="fx-v fx-v-woodgrain">at Homestead · est. 2026</span><span class="fx-v fx-v-classic">Pull up a chair. Stay a while.</span><span class="fx-v fx-v-clubhouse">the homestead clubhouse · members only · no parents allowed (jk mom)</span></div>' +
        '</div>' +
        '<div class="fx-counter" aria-label="Thread views">visitors: <b>' + String(stats.views || 0).padStart(6, '0') + '</b></div>' +
        '<div class="fx-loginbox">Welcome, ' + who({ username: me.username, display: name, isAdmin: me.isAdmin }) + '.' +
          (visited ? '<br>You last visited: ' + esc(visited) : '') +
          '<br><a href="#" data-action="usercp">User CP</a> · <a href="#" data-action="logout">Log Out</a></div>' +
      '</header>' +
      '<div class="fx-marquee" aria-hidden="true"><span>★ ' + esc(marquee.join(' ★ ')) + ' ★</span></div>' +
      '<nav class="fx-tabs" aria-label="Homestead">' + tabs.map(function (t) {
        return '<a href="' + esc(t.href) + '"' + (t.nav ? ' data-nav' : '') + ' class="' + (t.key === active ? 'on' : '') + '"' +
          (t.key === active ? ' aria-current="page"' : '') + '><span class="fx-tabicon" aria-hidden="true">' + t.icon + '</span>' + t.label + '</a>';
      }).join('') + '</nav>';
  }
  function navbar(crumbs, info) {
    return '<div class="fx-navbar"><span class="fx-crumb">' + crumbs.join(' <span class="fx-sep">›</span> ') + '</span>' +
      (info ? '<span class="fx-navinfo">' + info + '</span>' : '') + '</div>';
  }
  function footer() {
    return '<footer class="fx-foot">' +
      '<span class="fx-time">All times are local. The time now is ' + esc(clock(new Date())) + '.</span>' +
      '<label class="fx-style">Style: ' + chooser('skinChooser') + '</label>' +
      '<span class="fx-powered">Powered by Homestead · <span id="fxSkinName">' + esc(skinLabel(currentSkin())) + '</span> skin</span>' +
      '<div class="fx-badges" aria-hidden="true"><span>HTML 4.01</span><span>MADE W/ NOTEPAD</span><span>NO FRAMES</span><span>🔥 HEARTH INSIDE</span></div>' +
      '</footer>';
  }
  function box(title, inner, opts) {
    opts = opts || {};
    var id = opts.id ? ' data-box="' + esc(opts.id) + '"' : '';
    var collapsed = opts.id && collapsedSet().indexOf(opts.id) !== -1;
    return '<section class="fx-box' + (opts.cls ? ' ' + opts.cls : '') + (collapsed ? ' collapsed' : '') + '"' + id + '>' +
      '<h2 class="fx-thead"><span>' + title + '</span>' +
      (opts.id ? '<button type="button" class="fx-x" data-action="collapse" aria-expanded="' + !collapsed + '" aria-label="Collapse ' + esc(opts.label || '') + '">[' + (collapsed ? '+' : '–') + ']</button>' : (opts.extra || '')) +
      '</h2><div class="fx-tbody">' + inner + '</div></section>';
  }
  function collapsedSet() {
    try { return JSON.parse(store(COLLAPSE_STORE) || '[]'); } catch (_) { return []; }
  }

  function page(active, main, aside) {
    root.innerHTML = chrome(active) +
      '<div class="fx-layout"><main class="fx-main">' + main + '</main>' +
      (aside ? '<aside class="fx-side">' + aside + '</aside>' : '') + '</div>' + footer();
    root.setAttribute('aria-busy', 'false');
  }
  function fail(e) {
    var msg = e && e.status === 404 ? "That board or thread doesn't exist, or you can't see it." : 'Something went wrong loading the forum.';
    page('forum', navbar([link({}, 'The Forum')]) + box('Oops', '<p class="fx-empty">' + esc(msg) + ' ' + link({}, 'Back to the index') + '</p>'));
  }

  // ---------- index ----------

  function renderIndex() {
    return Promise.all([api('GET', '/api/forum/index'), refreshSidebar()]).then(function (r) {
      var idx = r[0];
      var cats = idx.categories.map(function (c) {
        var rows = c.boards.map(function (b) {
          var lp = b.lastPost;
          return '<div class="fx-frow' + (b.newSinceVisit ? ' unread' : '') + '">' +
            '<div class="ic" aria-hidden="true">' + (BOARD_ICONS[b.slug] || '💬') + '</div>' +
            '<div class="nm">' + link({ wall: b.slug }, esc(b.name), 'fx-board') +
              (b.newSinceVisit ? ' <span class="fx-badge">NEW</span>' : '') +
              (b.description ? '<div class="d">' + esc(b.description) + '</div>' : '') + '</div>' +
            '<div class="lp">' + (lp ? link({ post: lp.threadId }, esc(lp.title)) + '<br>by ' + who(lp.author, { plain: true }) + '<br>' + esc(when(lp.at)) : '<span class="fx-muted">Never</span>') + '</div>' +
            '<div class="n n-threads"><b>' + num(b.threadCount) + '</b><span class="u"> threads</span></div>' +
            '<div class="n n-posts"><b>' + num(b.postCount) + '</b><span class="u"> posts</span></div>' +
            '</div>';
        }).join('');
        return box(esc(c.name),
          '<div class="fx-tcat" aria-hidden="true"><span></span><span>Forum</span><span class="lp">Last Post</span><span class="n-threads">Threads</span><span class="n-posts">Posts</span></div>' + rows,
          { id: 'cat:' + c.name, label: c.name, cls: 'fx-cat' });
      }).join('');
      page('forum', navbar([link({}, 'The Forum')]) + (cats || box('The Forum', '<p class="fx-empty">No boards yet.</p>')), sidebar());
    });
  }
  function refreshSidebar() {
    return Promise.all([api('GET', '/api/forum/stats'), api('GET', '/api/forum/online')]).then(function (r) {
      state.stats = r[0]; state.online = r[1];
    });
  }
  function sidebar() {
    var s = state.stats || {}, o = state.online || { members: [], count: 0 };
    var agents = o.members.filter(function (m) { return /Agent/.test(m.rank); }).length;
    var names = o.members.map(function (m) { return who({ username: m.username, display: m.display, rank: m.rank, isAgent: /Agent/.test(m.rank) }); }).join(', ');
    var rows = [
      wgo('👥', 'Currently Active Users: ' + o.count + (agents ? ' (' + (o.count - agents) + ' members, ' + agents + ' house agent' + (agents > 1 ? 's' : '') + ')' : ''),
        (names || '<span class="fx-muted">Nobody but you.</span>') + '<br><span class="fx-muted">Active in the last ' + o.windowMinutes + ' minutes.</span>', 'online'),
    ];
    if ((s.birthdaysToday || []).length) {
      rows.push(wgo('🎂', "Today's Birthdays", s.birthdaysToday.map(function (b) { return esc(b.display || b.username) + ' 🎉'; }).join(', '), 'birthdays'));
    }
    rows.push(wgo('📊', 'Homestead Statistics', 'Threads: ' + num(s.threads) + ' · Posts: ' + num(s.posts) + ' · Members: ' + num(s.members) +
      (s.newestMember ? ' · Welcome to our newest member, <b>' + esc(s.newestMember.display || s.newestMember.username) + '</b>' : ''), 'stats'));
    if ((s.topPosters || []).length) {
      rows.push(wgo('🏅', 'Top Posters', '<ol class="fx-top">' + s.topPosters.map(function (t) {
        return '<li>' + (t.isAgent ? '🤖 ' : '') + who(t, { plain: true }) + ' — ' + num(t.postCount) + '</li>';
      }).join('') + '</ol>', 'top'));
    }
    return box("What's Going On?", rows.join(''), { id: 'wgo', label: "What's Going On", cls: 'fx-wgo' });
  }
  function wgo(icon, title, inner, key) {
    return '<div class="fx-wgo-row fx-wgo-' + key + '"><div class="ic" aria-hidden="true">' + icon + '</div>' +
      '<div class="b"><h3>' + esc(title) + '</h3><div>' + inner + '</div></div></div>';
  }

  // ---------- board ----------

  function renderBoard(slug, pageNo) {
    return api('GET', '/api/forum/boards/' + encodeURIComponent(slug) + '/threads?page=' + (pageNo || 1)).then(function (d) {
      var from = d.total ? (d.page - 1) * d.limit + 1 : 0;
      var to = Math.min(d.page * d.limit, d.total);
      var rows = d.threads.map(function (t) {
        var icon = t.sticky ? '📌' : (t.replies >= HOT_REPLIES ? '🔥' : '💬');
        return '<div class="fx-trow' + (t.isNew ? ' unread' : '') + '">' +
          '<div class="ic" aria-hidden="true">' + icon + '</div>' +
          '<div class="t">' + (t.sticky ? '<span class="fx-sticky">Sticky:</span> ' : '') + link({ post: t.id }, esc(t.title), 'fx-thread') +
            (t.isNew ? ' <span class="fx-badge">NEW</span>' : '') +
            '<div class="by">' + who(t.author, { plain: true }) + ' · ' + esc(when(t.createdAt)) + '</div></div>' +
          '<div class="lp">' + esc(when(t.lastPost.at)) + '<br>by ' + who(t.lastPost.by, { plain: true }) + '</div>' +
          '<div class="n"><b>' + num(t.replies) + '</b> <span class="u">replies</span><br><span class="fx-muted">' + num(t.views) + ' views</span></div>' +
          '</div>';
      }).join('');
      var pages = Math.max(1, Math.ceil(d.total / d.limit));
      var pager = '';
      if (pages > 1) {
        pager = '<nav class="fx-pager" aria-label="Pages"><span>Page ' + d.page + ' of ' + pages + '</span>';
        for (var i = 1; i <= pages; i++) {
          pager += i === d.page ? '<span class="on" aria-current="page">' + i + '</span>' : link({ wall: slug, page: i }, String(i));
        }
        if (d.page < pages) pager += link({ wall: slug, page: d.page + 1 }, '›') + link({ wall: slug, page: pages }, 'Last »');
        pager += '</nav>';
      }
      var composer = '<form class="fx-compose" id="newThread" hidden>' +
        '<label>Title<input name="title" maxlength="120" required autocomplete="off"></label>' +
        '<label>Message<textarea name="text" rows="6" required></textarea></label>' +
        smilies('newThread') +
        '<div class="fx-btns"><button type="button" class="fx-btn" data-action="cancel-thread">Cancel</button><button type="submit" class="fx-btn fx-primary">Submit New Thread</button></div></form>';
      page('forum',
        navbar([link({}, 'The Forum'), link({ wall: slug }, esc(d.board.name))], d.total ? 'Threads ' + from + ' to ' + to + ' of ' + num(d.total) : '') +
        '<button type="button" class="fx-newthread fx-btn fx-primary" data-action="new-thread">✎ New Thread</button>' + composer +
        box('Threads in Forum: ' + esc(d.board.name), rows || '<p class="fx-empty">No threads yet. Start one!</p>', { cls: 'fx-threads' }) + pager);
      root.querySelector('#newThread').addEventListener('submit', function (ev) {
        ev.preventDefault();
        var f = ev.target;
        submitting(f, api('POST', '/api/walls/' + encodeURIComponent(slug) + '/posts', {
          kind: 'text', title: f.title.value.trim(), text_body: f.text.value,
        }).then(function (post) { go({ post: post.id }); }));
      });
    });
  }
  function smilies(target) {
    return '<div class="fx-smilies" role="group" aria-label="Smilies">' + SMILIES.map(function (s) {
      return '<button type="button" data-action="smilie" data-target="' + target + '" aria-label="Insert ' + s + '">' + s + '</button>';
    }).join('') + '</div>';
  }
  function submitting(form, promise) {
    var btns = form.querySelectorAll('button[type=submit]');
    btns.forEach(function (b) { b.disabled = true; });
    var err = form.querySelector('.fx-err') || form.appendChild(Object.assign(document.createElement('p'), { className: 'fx-err', role: 'alert' }));
    err.textContent = '';
    return promise.catch(function (e) {
      err.textContent = 'Could not post: ' + e.message;
      btns.forEach(function (b) { b.disabled = false; });
    });
  }

  // ---------- thread ----------

  function renderThread(postId) {
    return api('GET', '/api/forum/threads/' + encodeURIComponent(postId)).then(function (d) {
      var t = d.thread;
      var first = postbit({
        member: t.member, author: t.author, at: t.createdAt, title: t.title, n: 0,
        text: threadBody(t), reactions: reactionBar(d.board.slug, t),
      });
      var replies = d.replies.map(function (r, i) {
        return postbit({ member: r.member, author: r.author, at: r.createdAt, title: 'Re: ' + t.title, n: i + 1, text: body(r.body), raw: r.body });
      }).join('');
      var quick = '<form class="fx-quick" id="quickReply">' +
        '<div class="fx-quick-who"><b>Quick Reply</b>' + smilies('quickReply') + '</div>' +
        '<div class="fx-quick-msg"><textarea name="text" rows="4" placeholder="Type your reply…" aria-label="Reply" required></textarea>' +
        '<div class="fx-btns"><button type="submit" class="fx-btn fx-primary">Post Quick Reply</button></div></div></form>';
      page('forum',
        navbar([link({}, 'The Forum'), link({ wall: d.board.slug }, esc(d.board.name)), '<span class="fx-here">' + esc(t.title) + '</span>'],
          num(t.views) + (t.views === 1 ? ' view' : ' views')) +
        box((t.sticky ? '📌 ' : '') + esc(t.title), first + replies + quick, { cls: 'fx-thread-box' }));
      root.dataset.thread = t.id;
      root.querySelector('#quickReply').addEventListener('submit', function (ev) {
        ev.preventDefault();
        submitting(ev.target, api('POST', '/api/walls/posts/' + encodeURIComponent(t.id) + '/comments', { body: ev.target.text.value })
          .then(function () { return renderThread(t.id); })
          .then(function () { var q = root.querySelector('.fx-post:last-of-type'); if (q) q.scrollIntoView({ block: 'center' }); }));
      });
    });
  }
  function threadBody(t) {
    var out = t.text ? body(t.text) : '';
    if (t.kind === 'image' && t.mediaId) out += '<img class="fx-media" src="/api/media/' + esc(t.mediaId) + '" alt="">';
    if (t.kind === 'video' && t.mediaId) out += '<video class="fx-media" src="/api/media/' + esc(t.mediaId) + '" controls preload="metadata"></video>';
    if (t.link && /^https?:\/\//i.test(t.link.url || '')) {
      out += '<a class="fx-linkcard" href="' + esc(t.link.url) + '" target="_blank" rel="noopener noreferrer"><b>' + esc(t.link.title || t.link.url) + '</b>' +
        (t.link.description ? '<span>' + esc(t.link.description) + '</span>' : '') + '</a>';
    }
    return out;
  }
  function reactionBar(slug, t) {
    var sum = t.reactionSummary || {}, mine = t.myReactions || [];
    return '<div class="fx-react" data-slug="' + esc(slug) + '" data-post="' + esc(t.id) + '">' + REACTIONS.map(function (r) {
      var on = mine.indexOf(r.key) !== -1;
      return '<button type="button" class="fx-emo' + (on ? ' on' : '') + '" data-action="react" data-emoji="' + esc(r.key) + '" aria-pressed="' + on + '">' +
        r.emoji + (r.label ? ' ' + r.label : '') + (sum[r.key] ? ' <b>' + sum[r.key] + '</b>' : '') + '</button>';
    }).join('') + '</div>';
  }
  function postbit(p) {
    var m = p.member || {};
    var a = p.author || {};
    var name = m.display || a.display || a.username || 'someone';
    var u = { username: m.username || a.username, display: name, rank: m.rank, isAgent: m.isAgent || a.isAgent };
    return '<article class="fx-post" id="post-' + p.n + '">' +
      '<div class="fx-who">' + avatar({ display: name, color: m.color, isAgent: u.isAgent }) +
        '<div class="fx-who-text"><div class="fx-who-name">' + who(u, { plain: true }) + '</div>' +
        '<div class="fx-rank">' + esc(m.rank || '') + '</div>' + stars(m.rank, u.isAgent) +
        '<div class="fx-meta">' + (m.joinedAt ? 'Join Date: ' + esc(joined(m.joinedAt)) + '<br>' : '') + 'Posts: ' + num(m.postCount) + '</div></div></div>' +
      '<div class="fx-msg">' +
        '<div class="fx-ptop"><span class="fx-ptitle">' + esc(p.title) + '</span><span class="fx-pdate">' + esc(when(p.at)) +
          ' <a href="#post-' + p.n + '" class="fx-pnum">#' + (p.n + 1) + '</a></span></div>' +
        '<div class="fx-pbody">' + p.text + '</div>' + (p.reactions || '') +
        (m.signature ? '<div class="fx-sig">' + esc(m.signature) + '</div>' : '') +
        '<div class="fx-btns"><button type="button" class="fx-btn" data-action="quote" data-name="' + esc(name) + '" data-n="' + p.n + '">Quote</button>' +
        '<button type="button" class="fx-btn" data-action="reply">Reply</button></div>' +
        (p.raw != null ? '<template class="fx-raw">' + esc(p.raw) + '</template>' : '') +
      '</div></article>';
  }

  // ---------- members ----------

  function renderMembers() {
    return api('GET', '/api/forum/index').then(function (idx) {
      var first = idx.categories.length && idx.categories[0].boards[0];
      if (!first) return [];
      return api('GET', '/api/walls/' + encodeURIComponent(first.slug) + '/members').then(function (d) { return d.members || []; });
    }).then(function (members) {
      var rows = members.map(function (m) {
        return '<div class="fx-mrow">' + avatar(m) + '<div class="t">' + who(m, { plain: true }) +
          '<div class="by">@' + esc(m.username) + (m.joined_at ? ' · joined ' + esc(joined(m.joined_at)) : '') + '</div></div></div>';
      }).join('');
      page('members', navbar([link({}, 'The Forum'), '<span class="fx-here">Members</span>'], members.length + ' members') +
        box('Member List', rows || '<p class="fx-empty">No members to show.</p>', { cls: 'fx-members' }));
    });
  }

  // ---------- user CP (profile/settings sheet) ----------

  function openUserCp() {
    var p = state.profile || {};
    var dlg = document.createElement('dialog');
    dlg.className = 'fx-sheet';
    dlg.setAttribute('aria-labelledby', 'ucpTitle');
    dlg.innerHTML = '<form method="dialog" class="fx-box" id="userCp"><h2 class="fx-thead" id="ucpTitle"><span>User Control Panel</span></h2><div class="fx-tbody">' +
      '<label>Forum style ' + chooser('skinChooserCp') + '</label>' +
      '<label>Signature <textarea name="signature" maxlength="200" rows="3">' + esc(p.signature || '') + '</textarea></label>' +
      '<label>Birthday (MM-DD) <input name="birthday" pattern="(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])" placeholder="10-23" value="' + esc(p.birthday || '') + '"></label>' +
      '<p class="fx-err" role="alert"></p>' +
      '<div class="fx-btns"><button value="cancel" class="fx-btn">Close</button><button value="save" class="fx-btn fx-primary" data-action="save-ucp">Save</button></div>' +
      '</div></form>';
    document.body.appendChild(dlg);
    dlg.addEventListener('close', function () { dlg.remove(); });
    dlg.querySelector('[data-action=save-ucp]').addEventListener('click', function (ev) {
      ev.preventDefault();
      var f = dlg.querySelector('form');
      api('PATCH', '/api/forum/me', { signature: f.signature.value, birthday: f.birthday.value.trim() || null })
        .then(function (prof) { state.profile = Object.assign(state.profile || {}, prof); dlg.close(); })
        .catch(function (e) { dlg.querySelector('.fx-err').textContent = 'Could not save: ' + e.message; });
    });
    dlg.showModal();
  }

  // ---------- routing ----------

  function route() {
    var q = new URLSearchParams(location.search);
    root.removeAttribute('data-thread');
    var view;
    if (q.get('post')) view = renderThread(q.get('post'));
    else if (q.get('wall')) view = renderBoard(q.get('wall'), parseInt(q.get('page'), 10) || 1);
    else if (q.get('view') === 'members') view = renderMembers();
    else view = renderIndex();
    return view.catch(fail);
  }
  function go(params) {
    history.pushState(null, '', href(params));
    window.scrollTo(0, 0);
    return route();
  }

  document.addEventListener('click', function (ev) {
    var a = ev.target.closest('a[data-nav]');
    if (a && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey && ev.button === 0) {
      ev.preventDefault();
      history.pushState(null, '', a.getAttribute('href'));
      window.scrollTo(0, 0);
      route();
      return;
    }
    var el = ev.target.closest('[data-action]');
    if (!el) return;
    var action = el.getAttribute('data-action');
    if (action === 'collapse') {
      var sec = el.closest('[data-box]');
      var key = sec.getAttribute('data-box');
      var set = collapsedSet().filter(function (k) { return k !== key; });
      var collapsed = !sec.classList.contains('collapsed');
      if (collapsed) set.push(key);
      store(COLLAPSE_STORE, JSON.stringify(set));
      sec.classList.toggle('collapsed', collapsed);
      el.textContent = collapsed ? '[+]' : '[–]';
      el.setAttribute('aria-expanded', String(!collapsed));
    } else if (action === 'new-thread') {
      var f = root.querySelector('#newThread');
      f.hidden = false; el.hidden = true; f.title.focus();
    } else if (action === 'cancel-thread') {
      root.querySelector('#newThread').hidden = true;
      root.querySelector('[data-action=new-thread]').hidden = false;
    } else if (action === 'smilie') {
      var ta = document.querySelector('#' + el.getAttribute('data-target') + ' textarea');
      insertAtCursor(ta, el.textContent);
    } else if (action === 'quote') {
      var raw = el.closest('.fx-msg').querySelector('.fx-raw');
      var text = raw ? raw.content.textContent : el.closest('.fx-msg').querySelector('.fx-pbody').innerText;
      var quoted = '> ' + el.getAttribute('data-name') + ' wrote:\n' + text.split('\n').filter(function (l) { return !/^>/.test(l); })
        .map(function (l) { return '> ' + l; }).join('\n') + '\n\n';
      var box2 = root.querySelector('#quickReply textarea');
      box2.value = quoted + box2.value;
      box2.focus();
      box2.setSelectionRange(box2.value.length, box2.value.length);
    } else if (action === 'reply') {
      root.querySelector('#quickReply textarea').focus();
    } else if (action === 'react') {
      var bar = el.closest('.fx-react');
      el.disabled = true;
      api('POST', '/api/walls/' + encodeURIComponent(bar.dataset.slug) + '/posts/' + encodeURIComponent(bar.dataset.post) + '/reactions',
        { emoji: el.getAttribute('data-emoji') })
        .then(function () { return renderThread(bar.dataset.post); })
        .catch(function () { el.disabled = false; });
    } else if (action === 'usercp') {
      ev.preventDefault(); openUserCp();
    } else if (action === 'logout') {
      ev.preventDefault();
      api('POST', '/api/logout').catch(function () {}).then(function () { location.href = '/'; });
    }
  });
  document.addEventListener('change', function (ev) {
    if (ev.target.matches('select[data-skin-chooser]')) setSkin(ev.target.value);
  });
  window.addEventListener('popstate', route);

  function insertAtCursor(ta, s) {
    if (!ta) return;
    var start = ta.selectionStart || ta.value.length, end = ta.selectionEnd || ta.value.length;
    ta.value = ta.value.slice(0, start) + s + ta.value.slice(end);
    ta.focus();
    ta.setSelectionRange(start + s.length, start + s.length);
  }

  // ---------- boot ----------

  api('GET', '/api/me').then(function (me) {
    if (!me || !me.user) { location.href = '/'; return null; }
    state.me = me;
    // Server value wins over the localStorage mirror.
    applySkin(me.forum_skin);
    return Promise.all([
      api('GET', '/api/forum/me').then(function (p) { state.profile = p; }).catch(function () {}),
      refreshSidebar().catch(function () {}),
    ]).then(route);
  }).catch(function (e) { console.error('[forum] boot failed', e); location.href = '/'; });
})();
