/* PHA-2823: persistent cross-page navigation.
 *
 * Homestead ships several standalone HTML entry points (porch.html,
 * modules.html, invites.html, connectors.html, ...) alongside the
 * index.html SPA. Each standalone page only had a "back" arrow to "/",
 * so a user who navigated into one had no way to reach the others
 * without knowing the URL (Tyler feedback on PHA-2804). This component
 * is a small bottom bar of links to the main app destinations, dropped
 * into a page with a single script tag:
 *
 *   <script src="/components/app-nav.js" data-active="porch"></script>
 *
 * data-active marks which link renders as the current page (skip it on
 * index.html, which already has its own in-SPA nav). Styling reads the
 * host page's existing --bg/--surface/--ink/--muted/--accent/--line
 * tokens, which every Homestead page already defines with the same
 * names, so no per-page CSS changes are needed.
 */
(function () {
  // Captured synchronously at load time — document.currentScript is only
  // valid during the initial (non-async) script execution, not later
  // inside a deferred DOMContentLoaded callback.
  var scriptEl = document.currentScript;

  var LINKS = [
    { key: 'wall', href: '/', icon: '🏠', label: 'Wall' },
    { key: 'porch', href: '/porch.html', icon: '📸', label: 'Porch' },
    { key: 'modules', href: '/modules.html', icon: '🧩', label: 'Rooms' },
    { key: 'invites', href: '/invites.html', icon: '✉️', label: 'Invites' },
    { key: 'connectors', href: '/connectors.html', icon: '🔌', label: 'Connect' }
  ];

  function mount() {
    var script = scriptEl || document.querySelector('script[src*="app-nav.js"]');
    var active = (script && script.getAttribute('data-active')) || '';

    var style = document.createElement('style');
    style.textContent =
      '#hs-app-nav{position:fixed;left:0;right:0;bottom:0;display:flex;justify-content:space-around;' +
      'padding:8px 6px calc(env(safe-area-inset-bottom) + 8px);background:var(--surface,#fff);' +
      'border-top:1px solid var(--line,rgba(43,38,34,.07));z-index:50}' +
      '#hs-app-nav a{display:flex;flex-direction:column;align-items:center;gap:3px;font-size:11px;' +
      'font-weight:600;color:var(--muted,#7a7269);text-decoration:none;padding:4px 8px;border-radius:10px;' +
      'font-family:inherit}' +
      '#hs-app-nav a.on{color:var(--accent,#C4703C)}' +
      '#hs-app-nav .hs-ico{font-size:19px;line-height:1}' +
      'body{padding-bottom:calc(64px + env(safe-area-inset-bottom))}';
    document.head.appendChild(style);

    var nav = document.createElement('nav');
    nav.id = 'hs-app-nav';
    nav.setAttribute('aria-label', 'Homestead navigation');
    nav.innerHTML = LINKS.map(function (l) {
      var on = l.key === active ? ' on' : '';
      var cur = l.key === active ? ' aria-current="page"' : '';
      return '<a href="' + l.href + '" class="' + l.key + on + '"' + cur + '>' +
        '<span class="hs-ico" aria-hidden="true">' + l.icon + '</span>' + l.label + '</a>';
    }).join('');

    document.body.appendChild(nav);
  }

  if (document.body) {
    mount();
  } else {
    document.addEventListener('DOMContentLoaded', mount);
  }
})();
