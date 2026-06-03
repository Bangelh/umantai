#!/usr/bin/env node
/**
 * Ensures Wrangler has the known Cloudflare Account ID and Pages project name cached.
 * This prevents wrangler from calling fetchAllAccounts() (which often fails with
 * "user account fetch permission denied" or authentication/permission errors
 * even when a valid but limited OAuth login or API token is present).
 *
 * Values are loaded via the shared module (config/primary-account.js) which is the
 * single source of truth for bangelh (bangelh2025@gmail.com) + linked services.
 */

const fs = require('fs');
const path = require('path');

// Use the shared primary account module (bangelh / bangelh2025@gmail.com).
// This is the single source of truth linking Cloudflare + Vercel + GitHub + summits + future.
let ACCOUNT_ID = 'a91810f9781cedd3a82123e71826fd4c';
let ACCOUNT_NAME = "Bangelh2025@gmail.com's Account";
try {
  // Adjust relative path as needed when copying this script to other projects.
  const primary = require('../../../config/primary-account');
  const cf = primary.getCloudflareAccount();
  if (cf.accountId) ACCOUNT_ID = cf.accountId;
  if (cf.accountName) ACCOUNT_NAME = cf.accountName;
} catch (e) {
  // non-fatal fallback (module or json not found from this CWD)
}
const PROJECT_NAME = 'umantai';

const cacheDir = path.join(__dirname, '..', 'node_modules', '.cache', 'wrangler');

try {
  fs.mkdirSync(cacheDir, { recursive: true });

  // wrangler-account.json is read by getOrSelectAccountId / getConfigCache
  const accountCachePath = path.join(cacheDir, 'wrangler-account.json');
  fs.writeFileSync(
    accountCachePath,
    JSON.stringify({ account: { id: ACCOUNT_ID, name: ACCOUNT_NAME } }),
    'utf8'
  );

  // pages.json is the PAGES_CONFIG_CACHE_FILENAME used by pages deploy commands
  const pagesCachePath = path.join(cacheDir, 'pages.json');
  fs.writeFileSync(
    pagesCachePath,
    JSON.stringify({ account_id: ACCOUNT_ID, project_name: PROJECT_NAME }),
    'utf8'
  );

  console.log('✅ Wrangler cache ensured for Cloudflare Pages deploy (account + project).');
  console.log(`   Account: ${ACCOUNT_ID}`);
  console.log(`   Project: ${PROJECT_NAME}`);
} catch (err) {
  console.warn('⚠️  Could not write wrangler cache (non-fatal):', err.message);
}
