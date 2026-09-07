'use strict';

// PHA-3327: Router extraction moves a server.js dependency into routes/.
// The production image has a deliberately narrow runtime COPY allowlist, so
// assert the directory is included before a deployment discovers it at boot.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');

assert.match(
  dockerfile,
  /^COPY\s+routes\s+\.\/routes\s*$/m,
  'runtime Dockerfile must copy routes/ for server.js router factories',
);

console.log('PHA-3327: Docker runtime routes copy contract passes (1/1)');
