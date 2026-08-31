// Homestead — in-process OIDC mock IdP for tests (PHA-2706).
//
// Spins up a small HTTP server that speaks just enough of the OIDC
// + OAuth 2.0 + JWKS surface for lib/oidc-link.js to complete the
// authorization-code flow without any external network dependency.
//
// Endpoints:
//   GET  /.well-known/openid-configuration       — discovery doc
//   GET  /jwks                                  — JWKS with one RSA key
//   GET  /authorize                             — issues a redirect to
//                                                  <redirect_uri>?code=...
//                                                  &state=... ; the
//                                                  caller (test) drives
//                                                  the user through the
//                                                  UI by hitting /authorize
//                                                  directly with the
//                                                  parameters it expects.
//   POST /token                                 — accepts the code +
//                                                  code_verifier and
//                                                  returns an id_token
//                                                  signed with the
//                                                  server's RSA key.
//                                                  Validates that
//                                                  code_verifier hashes
//                                                  to code_challenge.
//
// What this mock DOES NOT do:
//   * PKCE-only-no-secret — Authentik-style confidential clients
//     require the client secret, so the helper checks client_secret.
//   * User login UI — tests drive the helper directly. The
//     production flow goes through the real Authentik /authorize UI.
//   * Token refresh — not used by PHA-2706 (the link flow exchanges
//     exactly one code for exactly one id_token; the id_token
//     proof is what matters, the access token is discarded).
//
// The helper writes the relevant env vars on construction so
// lib/oidc-link.js picks them up without test scaffolding having to
// dance around module-load timing.

'use strict';

const http = require('http');
const crypto = require('crypto');
const url = require('url');

function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }

// Generate an RSA keypair once per helper instance. Persisted to the
// helper object so tests can read the public PEM out for signature
// verification.
function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  // Convert the SPKI PEM to a JWK for /.well-known/jwks.json.
  const pubKeyObj = crypto.createPublicKey(publicKey);
  const jwk = pubKeyObj.export({ format: 'jwk' });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey, jwk };
}

function makeIdToken({ issuer, clientId, subject, nonce, privateKeyPem, expiresInSec = 600, email, emailVerified = true, preferredUsername, name }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: 'homestead-test-key' };
  const claims = {
    iss: issuer,
    aud: clientId,
    sub: subject,
    nonce,
    iat: now,
    exp: now + expiresInSec,
    auth_time: now,
  };
  if (email) { claims.email = email; claims.email_verified = emailVerified; }
  if (preferredUsername) claims.preferred_username = preferredUsername;
  if (name) claims.name = name;
  const headerB64 = b64url(JSON.stringify(header));
  const claimsB64 = b64url(JSON.stringify(claims));
  const signingInput = headerB64 + '.' + claimsB64;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKeyPem);
  return signingInput + '.' + b64url(sig);
}

function startMockIssuer({ clientId = 'homestead-test', clientSecret = 'mock-secret', subject = 'mock-user-sub', redirectUri, onAuthorize, behavior = {} } = {}) {
  const { publicKeyPem, privateKeyPem, jwk } = generateKeyPair();
  const captured = { authorizeHits: 0, tokenHits: 0, lastCode: null, lastChallenge: null, lastSubject: subject };
  // The issuer is finalized once the server has a port; the discovery
  // endpoint + JWKS + token + authorize URLs all derive from it.
  let issuer = null;

  const server = http.createServer((req, res) => {
    const u = url.parse(req.url, true);
    if (req.method === 'GET' && u.pathname === '/.well-known/openid-configuration') {
      // Resolve issuer lazily so the port is known.
      if (!issuer) issuer = `http://127.0.0.1:${server.address().port}/`;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        issuer,
        authorization_endpoint: `http://127.0.0.1:${server.address().port}/authorize`,
        token_endpoint: `http://127.0.0.1:${server.address().port}/token`,
        jwks_uri: `http://127.0.0.1:${server.address().port}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        scopes_supported: ['openid', 'profile', 'email'],
      }));
      return;
    }
    if (req.method === 'GET' && u.pathname === '/jwks') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [{ ...jwk, kid: 'homestead-test-key', use: 'sig', alg: 'RS256' }] }));
      return;
    }
    if (req.method === 'GET' && u.pathname === '/authorize') {
      if (!issuer) issuer = `http://127.0.0.1:${server.address().port}/`;
      captured.authorizeHits++;
      const { redirect_uri, state, code_challenge, code_challenge_method, client_id, scope, nonce } = u.query;
      // Validate the request matches what we expect.
      if (client_id !== clientId) return _err(res, 400, 'unknown client_id');
      if (code_challenge_method !== 'S256') return _err(res, 400, 'only S256 PKCE supported');
      // Optional behavior overrides (e.g. subject swap, error injection).
      const effectiveSubject = behavior.subject || subject;
      // Mint an opaque code, stash the challenge + subject + nonce for /token.
      const code = crypto.randomBytes(16).toString('hex');
      captured.lastCode = code;
      captured.lastChallenge = code_challenge;
      captured.lastSubject = effectiveSubject;
      captured.lastNonce = nonce;
      // If behavior.consentRequired, pretend the user denied; otherwise approve.
      if (behavior.deny) {
        const denyUrl = new URL(redirect_uri);
        denyUrl.searchParams.set('error', 'access_denied');
        denyUrl.searchParams.set('error_description', 'mock denial');
        if (state) denyUrl.searchParams.set('state', state);
        res.writeHead(302, { location: denyUrl.toString() });
        res.end();
        return;
      }
      if (onAuthorize) onAuthorize({ code, code_challenge, redirect_uri, state });
      const okUrl = new URL(redirect_uri);
      okUrl.searchParams.set('code', code);
      if (state) okUrl.searchParams.set('state', state);
      res.writeHead(302, { location: okUrl.toString() });
      res.end();
      return;
    }
    if (req.method === 'POST' && u.pathname === '/token') {
      if (!issuer) issuer = `http://127.0.0.1:${server.address().port}/`;
      captured.tokenHits++;
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const params = new URLSearchParams(body);
        const code = params.get('code');
        const codeVerifier = params.get('code_verifier');
        const clientIdBody = params.get('client_id');
        const clientSecretBody = params.get('client_secret');
        const grantType = params.get('grant_type');
        if (grantType !== 'authorization_code') return _err(res, 400, 'unsupported_grant_type');
        if (clientIdBody !== clientId || clientSecretBody !== clientSecret) return _err(res, 401, 'invalid_client');
        if (code !== captured.lastCode) return _err(res, 400, 'invalid_grant (code mismatch)');
        // PKCE check: SHA256(code_verifier) must equal the challenge.
        const actualChallenge = b64url(crypto.createHash('sha256').update(codeVerifier || '').digest());
        if (actualChallenge !== captured.lastChallenge) return _err(res, 400, 'invalid_grant (PKCE failed)');
        const idToken = makeIdToken({
          issuer,
          clientId,
          subject: captured.lastSubject,
          nonce: captured.lastNonce,
          privateKeyPem,
          email: behavior.email || 'mockuser@example.com',
          preferredUsername: behavior.preferredUsername || captured.lastSubject,
          name: behavior.name || 'Mock User',
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id_token: idToken, access_token: 'mock-access', token_type: 'Bearer', expires_in: 600 }));
      });
      return;
    }
    _err(res, 404, 'not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      // Bind env vars to the mock's resolved endpoints so lib/oidc-link.js
      // can find it without test code having to set process.env on every call.
      const realIssuer = `http://127.0.0.1:${port}/`;
      const realRedirectUri = redirectUri || `http://127.0.0.1:${port}/callback`;
      const prev = {
        OIDC_ISSUER: process.env.OIDC_ISSUER,
        OIDC_CLIENT_ID: process.env.OIDC_CLIENT_ID,
        OIDC_CLIENT_SECRET: process.env.OIDC_CLIENT_SECRET,
        OIDC_REDIRECT_URI: process.env.OIDC_REDIRECT_URI,
        OIDC_AUTHORIZE_URL: process.env.OIDC_AUTHORIZE_URL,
        OIDC_TOKEN_URL: process.env.OIDC_TOKEN_URL,
      };
      process.env.OIDC_ISSUER = realIssuer;
      process.env.OIDC_CLIENT_ID = clientId;
      process.env.OIDC_CLIENT_SECRET = clientSecret;
      process.env.OIDC_REDIRECT_URI = realRedirectUri;
      process.env.OIDC_TOKEN_URL = `http://127.0.0.1:${port}/token`;
      // The default authorize URL builder assumes Authentik-shaped
      // issuers, which strips to /application/o/authorize/. The mock
      // exposes /authorize directly, so we point the override env at it.
      process.env.OIDC_AUTHORIZE_URL = `http://127.0.0.1:${port}/authorize`;

      const stop = () => {
        for (const [k, v] of Object.entries(prev)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        server.close();
      };
      resolve({
        port,
        issuer: realIssuer,
        redirectUri: realRedirectUri,
        clientId,
        clientSecret,
        publicKeyPem,
        captured,
        stop,
      });
    });
  });
}

function _err(res, code, msg) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: msg }));
}

module.exports = { startMockIssuer, generateKeyPair, makeIdToken };