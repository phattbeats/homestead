'use strict';
// Header-trust gate (PHA-3207).
//
// `X-authentik-username` / `X-authentik-groups` are an identity claim made
// by a reverse proxy that has already authenticated the browser (SWAG +
// Authentik outpost via nginx auth_request). Anything that can open a TCP
// connection to Homestead can send those headers, so they are only
// believed when the *direct peer* is a proxy the operator listed:
//
//   HOMESTEAD_TRUSTED_PROXIES=172.30.0.32,10.0.0.0/24,::1
//
// Entries are IPv4/IPv6 addresses or CIDR ranges; `loopback` is shorthand
// for 127.0.0.0/8 + ::1. Unset or empty means header-trust is OFF: the
// headers are ignored and the request falls through to the session cookie,
// OIDC or local login. That is the safe default for a published image.
//
// The peer is `req.socket.remoteAddress`, never `req.ip`: with
// `trust proxy` on, `req.ip` comes from X-Forwarded-For, which the client
// writes.
//
// The proxy must also overwrite (or strip) any client-supplied
// X-authentik-* headers. A trusted proxy that passes them through makes
// the spoof reachable from the internet again; this gate cannot see that.

const net = require('net');

function normalizeAddress(addr) {
  if (typeof addr !== 'string' || !addr) return null;
  // IPv4 peers on a dual-stack socket arrive as ::ffff:a.b.c.d.
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return mapped ? mapped[1] : addr;
}

// Returns { check(addr) -> bool, entries: string[], rejected: string[] }.
function parseTrustedProxies(spec) {
  const list = new net.BlockList();
  const entries = [];
  const rejected = [];
  for (const raw of String(spec || '').split(',')) {
    const item = raw.trim();
    if (!item) continue;
    if (item.toLowerCase() === 'loopback') {
      list.addSubnet('127.0.0.0', 8, 'ipv4');
      list.addAddress('::1', 'ipv6');
      entries.push(item);
      continue;
    }
    const [host, bitsRaw, extra] = item.split('/');
    const family = net.isIPv4(host) ? 'ipv4' : net.isIPv6(host) ? 'ipv6' : null;
    const max = family === 'ipv4' ? 32 : 128;
    const bits = bitsRaw === undefined ? max : Number(bitsRaw);
    if (!family || extra !== undefined || !Number.isInteger(bits) || bits < 0 || bits > max) {
      rejected.push(item);
      continue;
    }
    if (bits === max) list.addAddress(host, family);
    else list.addSubnet(host, bits, family);
    entries.push(item);
  }
  return {
    entries,
    rejected,
    check(addr) {
      if (!entries.length) return false;
      const a = normalizeAddress(addr);
      if (!a) return false;
      const family = net.isIPv4(a) ? 'ipv4' : net.isIPv6(a) ? 'ipv6' : null;
      return family ? list.check(a, family) : false;
    },
  };
}

function parseGroups(header) {
  const raw = header || '';
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((g) => typeof g === 'string' && g) : [];
    } catch (_) {
      return [];
    }
  }
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// Build the gate once at boot. `log` receives one line the first time an
// untrusted peer sends the header, so an operator who forgot to configure
// HOMESTEAD_TRUSTED_PROXIES after upgrading can see why SSO stopped.
function createHeaderTrust(spec, log = console.warn) {
  const trusted = parseTrustedProxies(spec);
  if (trusted.rejected.length) {
    log(`[header-trust] ignoring invalid HOMESTEAD_TRUSTED_PROXIES entries: ${trusted.rejected.join(', ')}`);
  }
  let warned = false;
  return {
    enabled: trusted.entries.length > 0,
    entries: trusted.entries,
    // { username, groups } when the request carries a trusted identity
    // claim, otherwise null.
    identity(req) {
      const username = req.get('x-authentik-username');
      if (!username) return null;
      const peer = req.socket && req.socket.remoteAddress;
      if (!trusted.check(peer)) {
        if (!warned) {
          warned = true;
          log(`[header-trust] ignored X-authentik-username from untrusted peer ${normalizeAddress(peer) || 'unknown'}`
            + (trusted.entries.length ? '' : ' (HOMESTEAD_TRUSTED_PROXIES is unset, header-trust is off)'));
        }
        return null;
      }
      return { username, groups: parseGroups(req.get('x-authentik-groups')) };
    },
  };
}

module.exports = { createHeaderTrust, parseTrustedProxies, parseGroups, normalizeAddress };
