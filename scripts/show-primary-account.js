#!/usr/bin/env node
/**
 * Print the primary account definition (bangelh).
 * Now prefers the unified bin wrapper.
 *
 * Run via: npm run cf:primary (from umantai/)
 */
const { spawnSync } = require('child_process');
const path = require('path');

const bin = path.join(__dirname, '..', '..', '..', 'config', 'bin', 'account.js');
const res = spawnSync(process.execPath, [bin, 'primary'], { stdio: 'inherit' });
if (res.status === 0) process.exit(0);

// Fallbacks
const central = path.join(__dirname, '..', '..', '..', 'config', 'show-primary.js');
const res2 = spawnSync(process.execPath, [central], { stdio: 'inherit' });
process.exit(res2.status || 0);
