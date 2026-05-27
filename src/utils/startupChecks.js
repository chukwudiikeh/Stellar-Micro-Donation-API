/**
 * Startup Checks Module
 *
 * RESPONSIBILITY: Verify critical configuration and dependencies before the server
 *                 accepts traffic. Fails fast on misconfiguration.
 * OWNER: Backend Team
 *
 * Usage:
 *   node src/utils/startupChecks.js        — run checks and exit
 *   require('./startupChecks').run()        — run checks programmatically
 */

'use strict';

const Database = require('./database');
const fs = require('fs');
const path = require('path');

const STELLAR_TIMEOUT_MS = 5000;

const results = [];

function pass(name, detail) {
  results.push({ name, status: 'pass', detail });
  console.log(`  ✔ ${name}${detail ? ': ' + detail : ''}`);
}

function warn(name, detail) {
  results.push({ name, status: 'warn', detail });
  console.warn(`  ⚠ ${name}${detail ? ': ' + detail : ''}`);
}

function fail(name, detail) {
  results.push({ name, status: 'fail', detail });
  console.error(`  ✖ ${name}${detail ? ': ' + detail : ''}`);
}

/** Check 1 — ENCRYPTION_KEY is set and has sufficient length */
function checkEncryptionKey() {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || !key.trim()) {
    fail('ENCRYPTION_KEY', 'not set — run `npm run generate-key` and add it to your .env file');
    return false;
  }
  if (key.length < 32) {
    fail('ENCRYPTION_KEY', `too short (${key.length} chars, minimum 32)`);
    return false;
  }
  pass('ENCRYPTION_KEY', 'set and valid');
  return true;
}

/** Check 2 — API_KEYS is configured */
function checkApiKeys() {
  const raw = process.env.API_KEYS;
  if (!raw || !raw.trim()) {
    fail('API_KEYS', 'not set — no requests will be authenticated');
    return false;
  }
  const keys = raw.split(',').map(k => k.trim()).filter(Boolean);
  if (keys.length === 0) {
    fail('API_KEYS', 'set but contains no valid keys');
    return false;
  }
  if (process.env.NODE_ENV === 'production') {
    warn(
      'API_KEYS (legacy)',
      `${keys.length} legacy key(s) detected in production. ` +
      'Legacy keys bypass quota tracking and cannot be revoked without a restart. ' +
      'Migrate to database-backed keys before 2026-12-31. ' +
      'See docs/MIGRATION_LEGACY_API_KEYS.md'
    );
  } else {
    pass('API_KEYS', `${keys.length} legacy key(s) configured (non-production)`);
  }
  return true;
}

/** Check 3 — Database connectivity */
async function checkDatabase() {
  try {
    await Database.get('SELECT 1 as ok');
    pass('Database', 'reachable');
    return true;
  } catch (err) {
    fail('Database', err.message);
    return false;
  }
}

/** Check 4 — Stellar network connectivity (with timeout) */
async function checkStellarNetwork() {
  try {
    const serviceContainer = require('../config/serviceContainer');
    const stellarService = serviceContainer.getStellarService();

    if (!stellarService.server || typeof stellarService.server.root !== 'function') {
      warn('Stellar network', 'mock mode — skipping live connectivity check');
      return true;
    }

    await Promise.race([
      stellarService.server.root(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`timed out after ${STELLAR_TIMEOUT_MS}ms`)), STELLAR_TIMEOUT_MS)
      ),
    ]);

    const network = stellarService.getNetwork ? stellarService.getNetwork() : 'unknown';
    pass('Stellar network', `reachable (${network})`);
    return true;
  } catch (err) {
    fail('Stellar network', err.message);
    return false;
  }
}

/** Check 5 — Database file and directory permissions (Issue #890) */
function checkDatabasePermissions() {
  const DATA_DIR = './data';
  const DB_PATH = path.join(DATA_DIR, 'stellar_donations.db');

  try {
    // Check data directory permissions
    if (fs.existsSync(DATA_DIR)) {
      const dirStats = fs.statSync(DATA_DIR);
      const dirMode = dirStats.mode & parseInt('777', 8);
      
      if (dirMode !== parseInt('700', 8)) {
        warn(
          'Database directory permissions',
          `${DATA_DIR} has permissions ${(dirMode).toString(8)} (should be 700). ` +
          'Run: chmod 700 data'
        );
      } else {
        pass('Database directory permissions', `${DATA_DIR} is 0700 (owner only)`);
      }
    }

    // Check database file permissions
    if (fs.existsSync(DB_PATH)) {
      const fileStats = fs.statSync(DB_PATH);
      const fileMode = fileStats.mode & parseInt('777', 8);
      
      if (fileMode !== parseInt('600', 8)) {
        warn(
          'Database file permissions',
          `${DB_PATH} has permissions ${(fileMode).toString(8)} (should be 600). ` +
          'Run: chmod 600 data/stellar_donations.db'
        );
      } else {
        pass('Database file permissions', `${DB_PATH} is 0600 (owner only)`);
      }
    }

    return true;
  } catch (err) {
    warn('Database permissions check', err.message);
    return true; // Don't fail on permission check errors
  }
}

/**
 * Run all startup checks.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.exitOnFailure=false] - call process.exit(1) if any critical check fails
 * @returns {Promise<{passed: boolean, results: Array}>}
 */
async function run({ exitOnFailure = false } = {}) {
  console.log('\nRunning startup checks…\n');

  const criticalResults = [
    checkEncryptionKey(),
    checkApiKeys(),
    await checkDatabase(),
    await checkStellarNetwork(),
    checkDatabasePermissions(),
  ];

  const passed = criticalResults.every(Boolean);

  console.log(`\nStartup checks ${passed ? 'passed ✔' : 'FAILED ✖'}\n`);

  if (!passed && exitOnFailure) {
    process.exit(1);
  }

  return { passed, results };
}

module.exports = { run, results };

// Allow running directly: `node src/utils/startupChecks.js`
if (require.main === module) {
  // Load .env when run standalone
  require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
  run({ exitOnFailure: true }).catch((err) => {
    console.error('Startup checks threw an unexpected error:', err.message);
    process.exit(1);
  });
}
