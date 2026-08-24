'use strict';

// PHA-2205 (PHA-2200.4): Add-a-room sheet (public/modules.html).
//
// Loads /api/modules (the full registry) + /api/me/layout (the user's
// enabled set + addRoomVisible flag). Renders one row per registry
// entry, with a toggle bound to POST /api/me/modules/:key/{enable,disable}.
//
// After every successful toggle we re-fetch /api/me/layout and stash
// the latest payload on `window.__lastLayout`. The SPA listens for
// the 'homestead:layout-changed' CustomEvent to refresh its tab bar
// without a full page reload (per acceptance bullet #2).
//
// Direct usage: open /modules.html → toggle → tap Done → goes back.
// Embedded usage: include this file from index.html then call
//   Modules.open({ container, onClose })
// where `container` is a DOM node the function will populate. Either
// path uses the same render pipeline below.
//
// IMPORTANT: this file is loaded INSIDE the SPA shell (index.html),
// which already declares `const $` at the top of its own inline
// <script>. Wrapping the module body in an IIFE keeps our `function
// $` / `function el` / etc. helpers from clashing with the SPA's
// top-level bindings (this was a real bug — caught by the smoke).

(function () {

const API = {
  async req(method, url, body) {
    const opts = {
      method,
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' },
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(url, opts);
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* leave json null */ }
    if (!r.ok) {
      const msg = (json && json.error) || ('HTTP ' + r.status);
      throw new Error(msg);
    }
    return json;
  },
  getRegistry()    { return this.req('GET',  '/api/modules'); },
  getLayout()      { return this.req('GET',  '/api/me/layout'); },
  enable(key)      { return this.req('POST', `/api/me/modules/${encodeURIComponent(key)}/enable`); },
  disable(key)     { return this.req('POST', `/api/me/modules/${encodeURIComponent(key)}/disable`); },
};

// ---- DOM helpers ----
// We DON'T redeclare `$` here — the parent page (index.html) does.
// Our local helper is `$sel` to avoid the clash.
function $sel(sel, root) { return (root || document).querySelector(sel); }
function el(tag, attrs, children) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
      else e.setAttribute(k, v);
    }
  }
  if (children !== undefined) {
    for (const c of [].concat(children)) {
      if (c == null) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
  }
  return e;
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---- State ----
let _state = {
  registry: [],         // [{key,name,description,icon,tier,default_enabled,open_mode,url,room}]
  enabled: new Set(),   // current enabled keys (live, from layout)
  layout: null,         // last /api/me/layout payload
  busy: false,          // a toggle is in flight
};

// Render the list of available rooms into the given container.
function renderList(container, onChange) {
  container.innerHTML = '';
  if (!_state.registry.length) {
    container.appendChild(el('p', { class: 'mods-empty', text: 'No rooms available right now.' }));
    return;
  }
  for (const m of _state.registry) {
    const isOn = _state.enabled.has(m.key);
    const row = el('article', {
      class: 'mods-row',
      dataset: { key: m.key, enabled: String(isOn) },
      onclick: async (ev) => {
        // Tapping the row (or its toggle) flips it.
        if (_state.busy) return;
        if (ev.target.closest && ev.target.closest('a,button.mods-info')) return;
        await toggleModule(m.key, container, onChange);
      },
    }, [
      el('div', { class: 'mods-icon', text: m.icon || '·' }),
      el('div', { class: 'mods-body' }, [
        el('div', { class: 'mods-name', text: m.name || m.key }),
        m.description ? el('div', { class: 'mods-desc', text: m.description }) : null,
        m.tier ? el('div', { class: 'mods-tier', text: m.tier }) : null,
      ]),
      el('div', { class: 'mods-toggle', role: 'switch', 'aria-checked': String(isOn), 'aria-label': (m.name || m.key) + (isOn ? ' on' : ' off') }),
    ]);
    container.appendChild(row);
  }
}

async function toggleModule(key, container, onChange) {
  _state.busy = true;
  const row = container.querySelector(`[data-key="${CSS.escape(key)}"]`);
  try {
    if (_state.enabled.has(key)) {
      await API.disable(key);
    } else {
      await API.enable(key);
    }
    // Refresh layout; this is the contract — POST/PATCH then GET.
    const layout = await API.getLayout();
    _state.layout = layout;
    _state.enabled = new Set(layout.tabs.map(t => t.key));
    window.__lastLayout = layout;
    window.dispatchEvent(new CustomEvent('homestead:layout-changed', { detail: layout }));
    renderList(container, onChange);
    if (typeof onChange === 'function') onChange(layout);
  } catch (err) {
    if (row) row.classList.add('mods-err');
    // Roll back optimistic UI on failure — leave registry rendered,
    // surface the message inline.
    if (row) {
      const body = row.querySelector('.mods-body');
      const existing = row.querySelector('.mods-err-msg');
      if (existing) existing.remove();
      const msg = el('div', { class: 'mods-desc mods-err-msg', text: 'Could not update: ' + (err && err.message ? err.message : 'unknown error') });
      body && body.appendChild(msg);
    }
  } finally {
    _state.busy = false;
  }
}

async function load(container, onChange) {
  container.innerHTML = '';
  container.appendChild(el('p', { class: 'mods-empty', text: 'Loading…' }));
  try {
    const [registry, layout] = await Promise.all([API.getRegistry(), API.getLayout()]);
    _state.registry = (registry && registry.modules) || registry || [];
    _state.layout = layout;
    _state.enabled = new Set(layout.tabs.map(t => t.key));
    window.__lastLayout = layout;
    renderList(container, onChange);
  } catch (err) {
    container.innerHTML = '';
    container.appendChild(el('p', { class: 'mods-empty', text: 'Could not load rooms: ' + (err && err.message ? err.message : 'unknown error') }));
  }
}

// ---- Standalone page (direct nav to /modules.html) ----
async function bootStandalone() {
  const list = $sel('#modsList');
  const back = $sel('#modsBack');
  const done = $sel('#modsDone');
  if (!list) return; // embedded mode, not standalone
  if (back) back.onclick = () => { history.length > 1 ? history.back() : (location.href = '/'); };
  if (done) done.onclick = () => { history.length > 1 ? history.back() : (location.href = '/'); };
  await load(list, null);
}

// ---- Public API ----
window.Modules = {
  // Programmatic API for the SPA to mount the sheet inside a container.
  async open(opts) {
    const container = (opts && opts.container) || document.body;
    const onChange = opts && opts.onChange;
    await load(container, onChange);
    return {
      reload: () => load(container, onChange),
      getLayout: () => _state.layout,
    };
  },
  // For tests / programmatic inspection.
  _state: () => _state,
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootStandalone);
} else {
  bootStandalone();
}

})(); // IIFE wrapper — keeps $ helper local so it doesn't clash
     // with the SPA shell's `const $` declaration.
