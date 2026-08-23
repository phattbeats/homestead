// Homestead — Connector Forge wizard projection (PHA-2448).
//
// Keeps the browser on a deliberately narrow rail: it can choose an
// in-repo template and supply installation values, but it never sends a
// mutable ConnectorSpec. The server stamps those values into the template,
// runs the canonical PHA-2444 validator, and returns a plain-language
// preview. Secrets are never placed in the spec or returned from this file.
'use strict';

const connectorSpec = require('./connector-spec');
const connectorInstall = require('./connector-install');
const templates = require('./connector-templates');

class ConnectorWizardError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.name = 'ConnectorWizardError';
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}

function migrate(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS connector_consent_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  installation_id INTEGER NOT NULL REFERENCES connector_installations(id) ON DELETE CASCADE,
  summary_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_connector_consent_log_install
  ON connector_consent_log(installation_id, created_at DESC);
`);
}

function build(templateId, values = {}) {
  const template = templates.getTemplate(templateId);
  if (!template) throw new ConnectorWizardError(404, 'template_not_found', 'Choose a supported connector template.');
  const baseUrl = String(values.baseUrl || '').trim();
  const secretRef = String(values.secretRef || '').trim();
  const installName = String(values.installName || values.name || template.name).trim() || template.name;
  if (!baseUrl) throw new ConnectorWizardError(422, 'base_url_missing', 'Target base URL is required.');
  if (!connectorInstall.isValidSecretRef(secretRef)) {
    throw new ConnectorWizardError(422, 'invalid_secret_ref', 'API key name must match [a-z0-9_-]{2,64}; paste the key below, not here.');
  }
  const spec = template.factory({ baseUrl, secretRef, name: installName });
  return { template, spec, baseUrl, secretRef, installName };
}

function validate(templateId, values = {}) {
  const built = build(templateId, values);
  // This is the one PHA-2444 policy engine. In particular it rejects
  // loopback, Homestead itself, private networks without consent, and
  // non-conforming specs/JSONPath before persistence is even possible.
  connectorSpec.validate(built.spec, {
    localNetworkConsent: !!values.localNetworkConsent,
    homesteadOrigin: values.homesteadOrigin || null,
  });
  const secretPlaintext = String(values.apiKey || '');
  if (!secretPlaintext.trim()) {
    throw new ConnectorWizardError(422, 'secret_missing', 'API key is required and is stored only in your encrypted secret store.');
  }
  if (secretPlaintext.length > 8192 || /[\u0000-\u001f\u007f]/.test(secretPlaintext)) {
    throw new ConnectorWizardError(422, 'invalid_secret', 'API key contains unsupported control characters.');
  }
  return { ...built, preview: preview(built.spec, built.installName) };
}

function preview(spec, installName) {
  const surfaces = spec.surfaces || {};
  const surfaceNames = [];
  if (surfaces.tile) surfaceNames.push('a status tile');
  if (surfaces.card) surfaceNames.push('a summary card');
  if (surfaces.entities) surfaceNames.push('entity-graph entries');
  if (surfaces.feed) surfaceNames.push('feed activity');
  const probes = spec.probes.map((probe) => ({
    id: probe.id,
    endpoint: `GET ${probe.request.path}`,
    fields: Object.keys(probe.extract || {}),
  }));
  return {
    title: installName,
    pollIntervalSeconds: spec.connection.minPollSeconds,
    pollIntervalLabel: every(spec.connection.minPollSeconds),
    endpoints: probes,
    surfaces: surfaceNames,
    consent: [
      `Read-only GET requests to ${probes.length} endpoint${probes.length === 1 ? '' : 's'} on your selected server`,
      `Store the API key encrypted for this account only`,
      `Populate ${surfaceNames.join(', ') || 'no visible surfaces'} after the first successful poll`,
    ],
  };
}

function every(seconds) {
  if (seconds % 3600 === 0) return `Every ${seconds / 3600} hour${seconds === 3600 ? '' : 's'}`;
  if (seconds % 60 === 0) return `Every ${seconds / 60} minute${seconds === 60 ? '' : 's'}`;
  return `Every ${seconds} seconds`;
}

module.exports = { ConnectorWizardError, migrate, build, validate, preview };
