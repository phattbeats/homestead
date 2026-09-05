// Homestead module registry (PHA-2203 / PHA-2200.2, v0.3.0).
//
// THE SOURCE OF TRUTH for every module a user can enable — built-in OR
// third-party. Per Amendment 1 (Brandon, comment 1afbe170) and the
// sibling issue PHA-2201 (third-party app contract), the registry is
// the SHARED intake path: built-ins MUST dogfood the same shape
// third-party apps use. No private internal-only fields allowed.
//
// It is a static JS object — not a DB table (that's `user_modules`,
// PHA-2202), not a plugin loader, not an in-process code loader. The
// registry ships in source; third-party manifests are merged in at
// install time by PHA-2201's install flow.
//
// The 16 fields per entry are the union of:
//   * PHA-2200 design-note §1 (key/name/description/icon/room/requires
//     /tier/url/open_mode/scopes/entity_kinds)
//   * PHA-2201 manifest contract (version/author/mcp/webhooks)
//   * PHA-2200 Amendment 2 (default_enabled — gates the new-user
//     provisioning list)
//
// `default_enabled` is the ONLY place that decides what a brand-new
// account sees (per Amendment 2). For v0.3.0 it's just 'wall'.
//
// PHA-2852 adds a 17th field, `room_kinds` — but OPTIONAL, not
// required. It declares "records owned by this module can be keyed to
// a location in the house" (see lib/house-rooms.js). Note the name
// collision it does NOT participate in: the `room` field above is the
// in-SPA nav discriminator (`porch`, `r-lists`, …); `room_kinds`
// refers to house rooms (HALL / DEN / KITCHEN). Two different
// concepts, and only the second one is a data model.
//
// It is deliberately absent from REQUIRED_FIELDS in
// lib/registry-validate.js: the PHA-2201 manifest contract is a
// 16-field promise third-party apps already ship against, and
// retroactively requiring a 17th would invalidate every published
// manifest. Entries that omit it simply declare no room-keyed records.

'use strict';

// -----------------------------------------------------------------------------
// Built-in modules. `url` is an INTERNAL Homestead route (frame/drawer) or
// null (drawer-only / external). Third-party apps register here too once
// installed (per PHA-2201) — see the commented popcorn_vote stub below for
// the shape third-party entries MUST match.
// -----------------------------------------------------------------------------
const REGISTRY = Object.freeze({
  wall: {
    key: 'wall',
    name: 'Porch',
    description: 'A feed of posts from people you share a wall with.',
    // PHA-2846: built-in modules now use an SVG path under /modules/.
    // The string remains the canonical 16-field `icon` field; the SPA
    // renders this as an <img> (built-in) vs an emoji span (third-party
    // manifest). See public/modules.html and openAppsSheetWith() in
    // public/index.html for the dispatch rule.
    icon: '/modules/porch.svg',
    room: 'porch',
    requires: [],
    tier: 'core',
    version: '1.0.0',
    author: 'homestead-core',
    url: '/porch.html',
    // `route` is the externally consumable deep link. Unlike `url`, it
    // must name an actual standalone document; SPA-only modules use `room`.
    route: '/porch.html',
    open_mode: 'frame',
    scopes: ['read:walls', 'write:walls:post'],
    mcp: false,
    webhooks: [],
    entity_kinds: ['wall_post', 'wall_member'],
    default_enabled: true, // Amendment 2: only wall is on by default
  },
  lists: {
    key: 'lists',
    name: 'Lists',
    description: 'Shared lists for groceries, packing, anything recurring.',
    icon: '/modules/lists.svg',
    room: 'r-lists',
    requires: [],
    tier: 'core',
    version: '1.0.0',
    author: 'homestead-core',
    url: '/lists.html',
    route: null,
    open_mode: 'frame',
    scopes: ['read:lists', 'write:lists'],
    mcp: true,
    webhooks: [],
    entity_kinds: ['list', 'list_item'],
    // A list can hang in a room ("kitchen whiteboard"), so list rows
    // may carry a house_room key. PHA-2852.
    room_kinds: ['house_room'],
    default_enabled: false,
  },
  calendar: {
    key: 'calendar',
    name: 'Calendar',
    description: 'Household calendar. Merged from sources you connect.',
    icon: '/modules/calendar.svg',
    room: 'r-calendar',
    requires: [],
    tier: 'core',
    version: '1.0.0',
    author: 'homestead-core',
    url: '/calendar.html',
    route: null,
    open_mode: 'frame',
    scopes: ['read:events', 'write:events'],
    mcp: true,
    webhooks: [],
    entity_kinds: ['event', 'event_series'],
    // Events are the first room-keyed record type — `events.room_id`
    // is live as of PHA-2852, and this is what tells the Gazette it
    // may print a location next to a listing.
    room_kinds: ['house_room'],
    default_enabled: false,
  },
  chores: {
    key: 'chores',
    name: 'Chores',
    description: 'Task list with rotations and history.',
    icon: '/modules/chores.svg',
    room: 'tasks',
    requires: ['lists'],
    tier: 'core',
    version: '1.0.0',
    author: 'homestead-core',
    url: '/chores.html',
    route: null,
    open_mode: 'frame',
    scopes: ['read:tasks', 'write:tasks'],
    mcp: true,
    webhooks: [],
    entity_kinds: ['task', 'task_rotation'],
    // "Vacuum the DEN" — chores are room-keyed by nature. The `tasks`
    // table doesn't carry room_id yet; this declaration is the
    // forward promise, same posture as chores' `requires: ['lists']`.
    room_kinds: ['house_room'],
    default_enabled: false,
  },
  apps: {
    key: 'apps',
    name: 'Apps',
    description: 'Tiled launcher for the services you use every day.',
    icon: '/modules/apps.svg',
    room: 'svc',
    requires: [],
    tier: 'core',
    version: '1.0.0',
    author: 'homestead-core',
    url: '/apps.html',
    route: null,
    open_mode: 'frame',
    scopes: ['read:services'],
    mcp: false,
    webhooks: [],
    entity_kinds: [],
    default_enabled: false,
  },
  agent: {
    key: 'agent',
    name: 'Agent',
    description: 'A drawer chat with your own assistant. BYOK.',
    icon: '/modules/agent.svg',
    room: null,
    requires: [],
    tier: 'advanced',
    version: '1.0.0',
    author: 'homestead-core',
    url: null,
    route: null,
    open_mode: 'drawer',
    scopes: ['agent:invoke'],
    mcp: true,
    webhooks: [],
    entity_kinds: [],
    default_enabled: false,
  },
  // PHA-2659 — the Homestead Gazette. A morning edition the user's own
  // BYOK harness writes from a context payload the server assembles
  // (today's tasks/events, overnight Porch activity, entity arrivals).
  //
  // Per the 2026-08-29 instruction on PHA-2659 ("users can add / remove
  // it as a module just like everything else") this is its OWN registry
  // key, not a perk unlocked by the agent module. `requires` still names
  // the agent module — no harness, no edition — which reuses the
  // cross-module gate already proven by chores/lists. Disabling the
  // agent module while this one is on trips the existing
  // `dependents_active` 409: no new cascade logic, just a new edge in
  // the existing graph.
  //
  // `open_mode: 'sheet'` is new (see docs/GAZETTE-DESIGN.md "Registry
  // entry"). The three prior modes don't fit "full-screen, non-nav,
  // opened on demand, cached per-day": `frame` is an in-SPA nav page,
  // `drawer` is the chat harness, `tab` is an external third-party
  // window. Gazette is the first registry-driven consumer of the SPA's
  // existing `openSheet()` mechanism. Because `room` is null, sheet
  // modules never claim a nav button — computeLayout() emits them in
  // `sheets` instead, the same way the drawer module is emitted via
  // `agentDrawer`.
  gazette: {
    key: 'gazette',
    name: 'Gazette',
    description: 'A morning edition your agent writes from what actually happened.',
    icon: '/modules/gazette.svg',
    room: null,
    requires: ['agent'],
    tier: 'advanced',
    version: '1.0.0',
    author: 'homestead-core',
    url: null,
    route: null,
    open_mode: 'sheet',
    scopes: ['read:gazette', 'agent:invoke'],
    mcp: false,
    webhooks: [],
    entity_kinds: ['gazette_edition'],
    default_enabled: false,
  },
  // Third-party apps register here once installed (per PHA-2201).
  // The popcorn_vote stub shows the shape; actual entries are merged
  // at install time by the PHA-2201 install flow.
  //
  // PHA-2052 dogfood note: the manifest below is deliberately smaller
  // than the original backlog sketch (no `mcp: true`, no `webhooks`,
  // no `entity_kinds`) — Homestead has no MCP tool host and no
  // outbound webhook dispatcher today, so declaring those would be
  // decorative. v0.1 proves the contract using only capabilities that
  // actually exist: read the media-club wall, and post an
  // announcement to it (which rides the existing wall_posts ->
  // notification_log pipeline for the "users get notified, click
  // through" ask — no bespoke poll/vote storage in Homestead itself).
  //
  //   popcorn_vote: {
  //     key: 'popcorn_vote',
  //     name: 'Popcorn Vote',
  //     description: 'Family movie night voting.',
  //     icon: '🍿',
  //     room: null,
  //     requires: [],
  //     tier: 'advanced',
  //     version: '0.1.0',
  //     author: 'homestead-external',
  //     url: 'https://popcorn.example.com/manifest',
  //     open_mode: 'tab',
  //     scopes: ['read:walls:media_club', 'write:walls:post'],
  //     mcp: false,
  //     webhooks: [],
  //     entity_kinds: [],
  //     default_enabled: false,
  //   },
});

// Registry iteration order. We preserve insertion order in JS objects
// (the spec for non-integer string keys since ES2015), so iterating
// Object.keys(REGISTRY) gives the order these six entries were
// declared above. Returned lists (DEFAULT_ENABLED, getEnabledModules)
// MUST respect this order — the SPA renders the home grid in the
// order modules appear here.
const REGISTRY_ORDER = Object.freeze(Object.keys(REGISTRY));

// Module keys currently registered (built-in + third-party merged at
// boot/install). Frozen so a bug doesn't silently extend the
// whitelist at runtime.
const MODULE_KEYS = Object.freeze(REGISTRY_ORDER.slice());

// Default-enabled modules for new-user provisioning. The ONLY place
// that decides what a brand-new account sees. For v0.3.0: just 'wall'.
const DEFAULT_ENABLED = Object.freeze(['wall']);

// -----------------------------------------------------------------------------
// Pure helpers. No DB access — getEnabledModules(db, userId) lives in
// lib/user-model.js since it needs to join against the user_modules
// table.
// -----------------------------------------------------------------------------

// `getModule(key)` returns the registered entry or null. Keys are
// case-sensitive (the DB CHECK constraint is too).
function getModule(key) {
  if (typeof key !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(REGISTRY, key) ? REGISTRY[key] : null;
}

// `listModules()` returns every registered entry as an array in
// registry order. Useful for the API's GET /api/modules list
// (PHA-2200.3, not in this issue's scope but the helper exists).
function listModules() {
  return REGISTRY_ORDER.map(k => REGISTRY[k]);
}

// `getRoomRoute(key)` returns a safe externally consumable deep link.
// `url` remains registry metadata for the module surface, but must not be
// advertised by the layout API unless it names a real standalone document.
// SPA-only modules navigate using their `room` discriminator instead.
function getRoomRoute(key) {
  const entry = getModule(key);
  if (!entry) return null;
  return typeof entry.route === 'string' ? entry.route : null;
}

// `getDefaultEnabled()` returns a copy of DEFAULT_ENABLED — the
// caller cannot mutate the registry's default list.
function getDefaultEnabled() {
  return DEFAULT_ENABLED.slice();
}

// `getRoomKinds(key)` returns the module's declared room kinds, or an
// empty array when the entry omits the optional `room_kinds` field.
// Callers use this to decide whether to offer a room picker on a
// record — never read `entry.room_kinds` directly, since most entries
// (and every pre-PHA-2852 third-party manifest) don't have it.
function getRoomKinds(key) {
  const entry = getModule(key);
  if (!entry || !Array.isArray(entry.room_kinds)) return [];
  return entry.room_kinds.slice();
}

// `modulesForRoomKind(kind)` — the reverse lookup, in registry order:
// which modules declare records keyed to this kind of room. The
// Gazette uses this to know which surfaces it may pull room-tagged
// listings from.
function modulesForRoomKind(kind) {
  return REGISTRY_ORDER.filter(k => getRoomKinds(k).includes(kind));
}

// `isModuleKey(key)` answers "is this a registered module key?"
// Case-sensitive, matches the DB CHECK constraint exactly.
function isModuleKey(key) {
  if (typeof key !== 'string') return false;
  return Object.prototype.hasOwnProperty.call(REGISTRY, key);
}

// `computeLayout(enabledKeys)` (PHA-2204 / PHA-2200.3) — given the
// user's enabled module keys in registry order, returns the SPA
// bootstrap shape used by GET /api/me/layout. The shape is designed
// for the SPA's three rendering modes (per PHA-2200 design note §3):
//
//   * 0 enabled          → 'empty'      (no rooms; show onboarding)
//   * 1 enabled (default → 'feed-only' (single tab, no drawer chrome)
//     is wall)
//   * 2-3 enabled        → 'feed-tabs'  (top tab strip, drawer chrome)
//   * 4+ enabled         → 'meadow'     (full grid + drawer + add-room)
//
// `addRoomVisible` is true when the user can still add rooms
// (registry has at least one non-enabled module). `agentDrawer`
// is true when the `agent` module is in the enabled set (the SPA
// renders the chat-drawer FAB). `defaultRoute` is the first enabled
// module's reachable deep link, or null when the active module is
// SPA-only (and for an empty set). `tabs` carries the tab metadata for 1-3 enabled
// modules; `pages` carries full-grid tiles for 4+.
//
// The shape is intentionally redundant (tabs + pages both carry the
// {key,icon,label,route} tuple) so the SPA can render either layout
// from a single payload without re-fetching.
function computeLayout(enabledKeys) {
  const keys = (Array.isArray(enabledKeys) ? enabledKeys : []).filter(k => isModuleKey(k));
  // Walk in registry order — caller may pass in any order; we normalize.
  const ordered = REGISTRY_ORDER.filter(k => keys.includes(k));
  const allKeys = REGISTRY_ORDER;
  const addRoomVisible = ordered.length < allKeys.length;

  // Build the tile tuple for every enabled module.
  //
  // `room` is the in-SPA view discriminator (PHA-2557) — the SPA's
  // nav button + page div share the `data-p` attribute and the SPA
  // maps a module to its nav button by `room === data-p`. For
  // drawer-mode modules (`agent`) `room` is null and the SPA wires
  // those to the chat-drawer FAB instead of a nav button.
  //
  // `route` is emitted only for an actual standalone deep-link page.
  // The other built-ins are in-SPA surfaces selected by `room`; exposing
  // their historical *.html `url` values would advertise known 404s.
  const tiles = ordered.map(k => {
    const e = REGISTRY[k];
    return {
      key: k,
      icon: e.icon,
      label: e.name,
      route: getRoomRoute(k),
      room: e.open_mode === 'frame' ? (typeof e.room === 'string' ? e.room : null) : null,
    };
  });

  let layout;
  if (tiles.length === 0) {
    layout = 'empty';
  } else if (tiles.length === 1) {
    layout = 'feed-only';
  } else if (tiles.length <= 3) {
    layout = 'feed-tabs';
  } else {
    layout = 'meadow';
  }

  const defaultRoute = tiles.length > 0 ? tiles[0].route : null;

  // PHA-2659: `sheets` carries the enabled `open_mode: 'sheet'` modules
  // (currently just Gazette). These are full-screen, on-demand surfaces
  // with no nav room — the SPA renders one launcher affordance per
  // entry and calls openSheet() against the module's own fetch path.
  // Emitted as its own array rather than a per-key boolean (the shape
  // `agentDrawer` uses) so a second sheet module needs no payload
  // change. Derived from `open_mode`, never from a key literal, so
  // applyLayout() stays registry-driven per PHA-2209 Amendment 3.
  const sheets = ordered
    .filter(k => REGISTRY[k].open_mode === 'sheet')
    .map(k => ({ key: k, icon: REGISTRY[k].icon, label: REGISTRY[k].name }));

  return {
    layout,
    tabs: tiles,
    pages: tiles, // SPA picks one based on layout; always populated.
    defaultRoute,
    addRoomVisible,
    agentDrawer: keys.includes('agent'),
    sheets,
  };
}

module.exports = {
  REGISTRY,
  REGISTRY_ORDER,
  MODULE_KEYS,
  DEFAULT_ENABLED,
  getModule,
  listModules,
  getRoomRoute,
  getRoomKinds,
  modulesForRoomKind,
  getDefaultEnabled,
  isModuleKey,
  computeLayout,
};
