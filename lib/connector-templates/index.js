// Homestead — Connector reference template registry (PHA-2448, Connector
// Forge form wizard).
//
// Single entry point for the wizard's template picker: a flat list of
// ship-with-Homestead ConnectorSpec templates, in display order, each
// paired with a `factory(overrides)` for stamping the user's per-install
// overrides (baseUrl + secretRef name + identity overrides).
//
// Adding a new ship-with template means dropping a new
// `lib/connector-templates/<id>.js` next to komga.js and adding a row
// here. Everything else (the form wizard, the validator, the install
// API) picks it up automatically.
//
// The list order is deliberate: Komga first (the canonical Tyler's
// comics use case from PHA-2428), then Kavita (comics twin), then the
// *arr family grouped together (sharing auth shape and trust posture),
// then Plex and Jellyfin (broader media servers).

'use strict';

const komga = require('./komga');
const kavita = require('./kavita');
const sonarr = require('./sonarr');
const radarr = require('./radarr');
const readarr = require('./readarr');
const lidarr = require('./lidarr');
const prowlarr = require('./prowlarr');
const plex = require('./plex');
const jellyfin = require('./jellyfin');

// Display order: komga → kavita → *arr family (alphabetical: lidarr,
// prowlarr, radarr, readarr, sonarr — Sonarr as the historical anchor
// last) → plex → jellyfin. Tweak here to change the wizard's first
// impression.
const TEMPLATE_ORDER = Object.freeze([
  'komga',
  'kavita',
  'sonarr',
  'radarr',
  'readarr',
  'lidarr',
  'prowlarr',
  'plex',
  'jellyfin',
]);

const TEMPLATES = Object.freeze({
  komga,
  kavita,
  sonarr,
  radarr,
  readarr,
  lidarr,
  prowlarr,
  plex,
  jellyfin,
});

// listTemplates() → array of template descriptors, in display order.
//
// Each descriptor is the shape the wizard consumes:
//
//   {
//     id: 'komga',
//     name: 'Komga',
//     icon: '📚',
//     category: 'media',
//     defaults: { baseUrl, secretRef, minPollSeconds },
//     auth: { type, name },
//     description: 'Comics/manga server (the canonical Tyler's comics app).',
//     fields: [
//       { id: 'baseUrl',    label: 'Base URL',  type: 'url', required: true },
//       { id: 'secretRef',  label: 'API key name', type: 'text', required: true,
//                              hint: 'A reference name for your secret in the per-user encrypted store.' },
//       { id: 'name',       label: 'Display name', type: 'text', required: false,
//                              hint: 'How this connector shows up in your tiles.' },
//     ],
//     factory: factoryFn   // (overrides) → ConnectorSpec
//   }
//
// The wizard reuses `fields` to render the form layout and to drive
// the live validation pass — each field maps directly to the
// install() opts. `defaults` carry the per-template baseline so a
// fresh pick is one drop-in.
function listTemplates() {
  const out = [];
  for (const id of TEMPLATE_ORDER) {
    const t = TEMPLATES[id];
    if (!t || typeof t.factory !== 'function') continue;
    const sample = t.factory({});
    const d = (t.DEFAULTS && typeof t.DEFAULTS === 'object') ? t.DEFAULTS : {};
    const auth = (sample.connection && sample.connection.auth) || {};
    out.push({
      id,
      name: (sample.identity && sample.identity.name) || id,
      icon: (sample.identity && sample.identity.icon) || '🔌',
      category: (sample.identity && sample.identity.category) || 'other',
      defaults: {
        baseUrl: d.baseUrl || '',
        secretRef: d.secretRef || '',
        minPollSeconds: d.minPollSeconds || 300,
      },
      auth: {
        type: auth.type || 'header',
        name: auth.name || '',
      },
      // Free-form one-liner the wizard shows under the template's
      // name in the picker. Reduces to "what's this for" plus the
      // canonical app homepage.
      description: TEMPLATE_DESCRIPTIONS[id] || '',
      // The id-card of fields the wizard renders. Drive straight
      // from the spec shape so a new template only adds one entry
      // here AND its lib file — no separate "what does this template
      // need" file to drift.
      fields: [
        {
          id: 'baseUrl',
          label: 'Target base URL',
          type: 'url',
          required: true,
          placeholder: d.baseUrl || 'https://your-server.example.com',
          hint: 'The base URL of your app. Use the local-network consent flow if the app runs on your LAN.',
        },
        {
          id: 'secretRef',
          label: 'API key name',
          type: 'text',
          required: true,
          placeholder: d.secretRef || 'api_key',
          // Lets the user use multiple installs of the same template
          // without colliding — Komga and a Komga-test instance are
          // both allowed by the encrypted store (per-user namespace).
          hint: 'A reference name for the API key in your encrypted secret store. Match `[a-z0-9_-]{2,64}`.',
          pattern: '^[a-z0-9_-]{2,64}$',
        },
        {
          id: 'name',
          label: 'Display name',
          type: 'text',
          required: false,
          placeholder: (sample.identity && sample.identity.name) || id,
          hint: 'How this connector shows up in your tiles. Defaults to the template name.',
        },
      ],
      factory: t.factory,
    });
  }
  return out;
}

// getTemplate(id) → single descriptor or null. The wizard uses this
// when the user picks a tile — pulls the descriptor fresh so the
// defaults track the latest DEFAULTS in the template file.
function getTemplate(id) {
  return listTemplates().find((t) => t.id === id) || null;
}

// TEMPLATE_DESCRIPTIONS — free-form, concise. Localised to the
// template's domain. Keep these aligned with the issue tracker for
// future ramp-3 import/share work (the share UI will reuse these
// descriptions).
const TEMPLATE_DESCRIPTIONS = Object.freeze({
  komga: "Comics, manga, and bookshelf server. The canonical Tyler's-comics scenario from PHA-2428.",
  kavita: 'Comics, manga, and ebook server — Kovah-style alternative to Komga.',
  sonarr: 'TV-show PVR. Pulls series counts and recently-added episodes.',
  radarr: 'Movies PVR. Pulls movie library counts and recent additions.',
  readarr: 'Books / audiobooks PVR. Library + recent additions.',
  lidarr: 'Music PVR. Artist + album counts.',
  prowlarr: 'Indexer manager — the search aggregator that feeds Sonarr/Radarr etc.',
  plex: 'Plex Media Server. Library sections, recent items.',
  jellyfin: 'Jellyfin Media Server. Library folders + recently added items.',
});

module.exports = {
  listTemplates,
  getTemplate,
  TEMPLATE_ORDER,
  TEMPLATES,
};
