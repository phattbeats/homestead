// Homestead — third-party app consent screen (PHA-2201.2 / PHA-2230).
//
// Vanilla JS, no build step, no framework — same convention as
// public/porch.js. Renders the manifest preview + the mapped scope
// phrases (from /lib/scope-display.js, PHA-2230's shared mapping) in
// the two-column "will be able to" / "will NOT be able to" layout from
// the PHA-2201 design note §4. Copy is the verbatim v1 baseline —
// intentionally NOT derived from what's actually true beyond the
// scopes[] list (design note §4: no raw manifest JSON, no token value,
// no "I trust this author" checkbox, no code-signing badge).
//
// The install endpoints (POST /api/apps/resolve, /consent, /install)
// are PHA-2229 and not built yet — this screen has no DB dependency
// (PHA-2230's scope) and renders purely from a manifest + scopes[]
// list. `renderConsentScreen` is the reusable piece PHA-2229's install
// flow will call directly with its own resolved manifest; this page's
// own boot() below is a standalone demo/preview harness in the
// meantime, reading a pending install from sessionStorage if one was
// set, otherwise falling back to a bundled sample manifest.
'use strict';

(function () {
  const $ = (s, el) => (el || document).querySelector(s);

  // Verbatim v1 baseline (design note §4) — not derived from the
  // scopes[] list. Every app gets this same "will NOT" block.
  const FIXED_WILL_NOT_LINES = [
    'See any other walls (family, household, etc.) you belong to',
    'See your private notes, lists, or calendar',
    'Act as you to other users',
    'Run code inside Homestead',
  ];

  const WEBHOOK_PHRASES = {
    'wall_post.created': 'Receive a webhook when a new post appears',
  };

  function describeWebhook(hook) {
    return WEBHOOK_PHRASES[hook.event] || `Receive a webhook for "${hook.event}"`;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // renderConsentScreen(root, manifest, scopes, handlers?) — the
  // reusable piece. `root` is the container holding the ids below
  // (public/consent.html's #app, or any host markup with the same
  // structure). Throws if `scopes` contains anything outside the
  // PHA-2201 §3 vocabulary — see lib/scope-display.js.
  function renderConsentScreen(root, manifest, scopes, handlers) {
    handlers = handlers || {};

    const willPhrases = window.ScopeDisplay.describeScopes(scopes || [], {
      entityKinds: manifest.entity_kinds || [],
    });
    (manifest.webhooks || []).forEach((hook) => willPhrases.push(describeWebhook(hook)));

    $('#appIcon', root).textContent = manifest.icon || '';
    $('#appName', root).textContent = manifest.name;
    $('#appAuthorVersion', root).textContent = `by ${manifest.author} · v${manifest.version}`;
    $('#appDescription', root).textContent = manifest.description || '';

    $('#consentIntro', root).textContent =
      `You're about to install ${manifest.name} by ${manifest.author} (v${manifest.version}).`;

    $('#willList', root).innerHTML = willPhrases.map((p) => `<li>${esc(p)}</li>`).join('');
    $('#willNotList', root).innerHTML = FIXED_WILL_NOT_LINES.map((p) => `<li>${esc(p)}</li>`).join('');

    $('#consentFooter', root).textContent =
      "You can revoke this app at any time from Settings → Apps.\n" +
      "Revoking deletes the app's access token and removes the tile.";

    $('#installBtn', root).textContent = `Install ${manifest.name}`;
    $('#installBtn', root).onclick = handlers.onInstall || null;
    $('#cancelBtn', root).onclick = handlers.onCancel || null;
  }

  const PENDING_KEY = 'homestead_pending_app_install';

  const DEMO_MANIFEST = {
    key: 'popcorn_vote',
    name: 'Popcorn Vote',
    description: 'Family movie night voting.',
    icon: '🍿',
    version: '0.1.0',
    author: 'Brandon Mechling',
    entity_kinds: ['movie', 'vote'],
    webhooks: [{ event: 'wall_post.created', target: '/hook' }],
  };
  const DEMO_SCOPES = ['read:me', 'read:walls:media_club', 'write:walls:post', 'write:votes'];

  function readPending() {
    try {
      const raw = sessionStorage.getItem(PENDING_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.manifest) return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function boot() {
    const pending = readPending();
    const manifest = pending ? pending.manifest : DEMO_MANIFEST;
    const scopes = pending ? pending.scopes || [] : DEMO_SCOPES;
    $('#demoBanner').hidden = !!pending;

    renderConsentScreen($('#app'), manifest, scopes, {
      onCancel() {
        sessionStorage.removeItem(PENDING_KEY);
        history.back();
      },
      onInstall() {
        // POST /api/apps/install lands with PHA-2229. Until then this
        // screen only proves the render contract, not the write.
        window.alert('Install endpoint not built yet (PHA-2229).');
      },
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.HomesteadConsent = { renderConsentScreen, FIXED_WILL_NOT_LINES };
})();
