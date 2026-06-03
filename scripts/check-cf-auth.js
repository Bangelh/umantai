#!/usr/bin/env node
/**
 * Pre-flight check for Cloudflare authentication before deploy.
 * Prints clear, copy-pasteable instructions if the user is not authenticated
 * or lacks a CLOUDFLARE_API_TOKEN. This directly addresses the common
 * "authentication/permission" errors seen with wrangler pages deploy.
 *
 * Uses primary bangelh account (see scripts/ensure-wrangler-cache.js + root config/primary-account.json).
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Run the cache ensure as a side effect (idempotent) — loads via shared primary-account module (bangelh)
require('./ensure-wrangler-cache');

let ACCOUNT_ID = 'a91810f9781cedd3a82123e71826fd4c';
try {
  const primary = require('../../../config/primary-account');
  const cf = primary.getCloudflareAccount();
  if (cf.accountId) ACCOUNT_ID = cf.accountId;
} catch (_) {}

const hasApiToken = !!process.env.CLOUDFLARE_API_TOKEN;

let isLoggedIn = false;
try {
  const whoami = execSync('npx wrangler whoami', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  isLoggedIn = !/not authenticated|You are not authenticated|Not logged in/i.test(whoami);
} catch (e) {
  isLoggedIn = false;
}

if (!isLoggedIn && !hasApiToken) {
  console.error(`
❌ Cloudflare authentication required (authentication/permission error).

You are not logged in and CLOUDFLARE_API_TOKEN is not set.

Quick fixes:

1. Interactive login (opens browser):
   npx wrangler login
   npm run deploy:cloudflare

2. Recommended for CI / repeated deploys — create an API token:
   - Visit: https://dash.cloudflare.com/profile/api-tokens
   - Create Custom Token with these permissions:
       Account > Account Settings: Read
       Account > Pages: Edit
   - Then run:
     $env:CLOUDFLARE_API_TOKEN="your_token_here"
     npm run deploy:cloudflare

   (You can also combine with the account ID:)
     $env:CLOUDFLARE_ACCOUNT_ID="${ACCOUNT_ID}"; $env:CLOUDFLARE_API_TOKEN="..."; npm run deploy:cloudflare

After authenticating once, subsequent deploys often work without re-entering the token
because wrangler caches the session (we also pre-seed the account/project cache).

See wrangler.toml (top of file) and README.md for more details.
`);
  process.exit(1);
}

if (hasApiToken) {
  console.log('✅ Using CLOUDFLARE_API_TOKEN for authentication.');
} else if (isLoggedIn) {
  console.log('✅ Using active wrangler login session.');
}

console.log('✅ Cloudflare auth check passed. Proceeding with deploy...');
