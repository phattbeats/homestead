// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 PHATT Tech LLC

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
    icon: '📸',
    room: 'porch',
    requires: [],
    tier: 'core',
    version: '1.0.0',
    author: 'homestead-core',
    url: '/porch.html',
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
    icon: '📝',
    room: 'lists',
    requires: [],
    tier: 'core',
    version: '1.0.0',
    author: 'homestead-core',
    url: '/lists.html',
    open_mode: 'frame',
    scopes: ['read:lists', 'write:lists'],
    mcp: true,
    webhooks: [],
    entity_kinds: ['list', 'list_item'],
    default_enabled: false,
  },
  calendar: {
    key: 'calendar',
    name: 'Calendar',
    description: 'Household calendar. Merged from sources you connect.',
    icon: '📅',
    room: 'calendar',
    requires: [],
    tier: 'core',
    version: '1.0.0',
    author: 'homestead-core',
    url: '/calendar.html',
    open_mode: 'frame',
    scopes: ['read:events', 'write:events'],
    mcp: true,
    webhooks: [],
    entity_kinds: ['event', 'event_series'],
    default_enabled: false,
  },
  chores: {
    key: 'chores',
    name: 'Chores',
    description: 'Task list with rotations and history.',
    icon: '✓',
    room: 'tasks',
    requires: ['lists'],
    tier: 'core',
    version: '1.0.0',
    author: 'homestead-core',
    url: '/chores.html',
    open_mode: 'frame',
    scopes: ['read:tasks', 'write:tasks'],
    mcp: true,
    webhooks: [],
    entity_kinds: ['task', 'task_rotation'],
    default_enabled: false,
  },
  apps: {
    key: 'apps',
    name: 'Apps',
    description: 'Tiled launcher for the services you use every day.',
    icon: '🛰️',
    room: 'svc',
    requires: [],
    tier: 'core',
    version: '1.0.0',
    author: 'homestead-core',
    url: '/apps.html',
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
    icon: '💬',
    room: null,
    requires: [],
    tier: 'advanced',
    version: '1.0.0',
    author: 'homestead-core',
    url: null,
    open_mode: 'drawer',
    scopes: ['agent:invoke'],
    mcp: true,
    webhooks: [],
    entity_kinds: [],
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

// `getRoomRoute(key)` returns the URL the SPA should navigate to for
// the module's "open" action. For frame-mode modules that's the
// internal `url` field; for drawer-mode modules null is returned
// (drawer modules open via the drawer mechanism, not a route
// navigation); for tab-mode modules null is returned (new tab opens
// the external URL via the host).
function getRoomRoute(key) {
  const entry = getModule(key);
  if (!entry) return null;
  if (entry.open_mode !== 'frame') return null;
  return typeof entry.url === 'string' ? entry.url : null;
}

// `getDefaultEnabled()` returns a copy of DEFAULT_ENABLED — the
// caller cannot mutate the registry's default list.
function getDefaultEnabled() {
  return DEFAULT_ENABLED.slice();
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
// renders the chat-drawer FAB). `defaultRoute` is the first
// enabled module's room route (falls back to '/onboarding.html' for
// an empty set). `tabs` carries the tab metadata for 1-3 enabled
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
  const tiles = ordered.map(k => {
    const e = REGISTRY[k];
    return {
      key: k,
      icon: e.icon,
      label: e.name,
      route: e.open_mode === 'frame' ? e.url : null,
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

  const defaultRoute = tiles.length > 0 && typeof tiles[0].route === 'string'
    ? tiles[0].route
    : '/onboarding.html';

  return {
    layout,
    tabs: tiles,
    pages: tiles, // SPA picks one based on layout; always populated.
    defaultRoute,
    addRoomVisible,
    agentDrawer: keys.includes('agent'),
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
  getDefaultEnabled,
  isModuleKey,
  computeLayout,
};