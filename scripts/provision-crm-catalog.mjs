#!/usr/bin/env node
// Creates the sellable catalog in HighLevel: services, add-ons, deposits and
// memberships — 88 products and 142 prices.
//
//   node scripts/provision-crm-catalog.mjs                     # dry run (default)
//   node scripts/provision-crm-catalog.mjs --kinds service     # narrow the run
//   node scripts/provision-crm-catalog.mjs --apply             # write to the CRM
//
// Two properties, both deliberate:
//
//   * **Dry run is the default.** A bare run prints exactly what it would create
//     and writes nothing, to the CRM or to Postgres.
//   * **It never touches what it did not create.** Products are matched on a
//     marker in their description; the pre-existing $30/$50 deposit products carry
//     none, so this tool cannot see them. It creates NEW, marked deposit products
//     alongside them — see the note printed at the end.
//
// Re-running is safe and resumable: everything already provisioned is recognised
// and skipped.

import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const crmCatalog = require('../api/_lib/crm-catalog.js');
const provisioning = require('../api/_lib/crm-catalog-provisioning.js');
const ghl = require('../api/_lib/ghl.js');

const args = process.argv.slice(2);
const flags = new Set(args.filter(arg => arg.startsWith('--')));
const APPLY = flags.has('--apply');
const SKIP_DB = flags.has('--skip-db');

function valueFor(name) {
  const index = args.indexOf(name);
  return index > -1 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : null;
}

const kinds = (valueFor('--kinds') || crmCatalog.KINDS.join(',')).split(',').map(kind => kind.trim()).filter(Boolean);

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

let config;
try {
  // Products and prices have nothing to do with the agenda, so this deliberately
  // does NOT use getConfig(): demanding the four van calendars to create a
  // catalogue would be an unrelated obstacle.
  config = ghl.getPaymentsConfig();
} catch (error) {
  fail('Set GHL_PRIVATE_TOKEN and GHL_LOCATION_ID before provisioning.');
}

const unknown = kinds.filter(kind => !crmCatalog.KINDS.includes(kind));
if (unknown.length) fail(`Unknown --kinds value: ${unknown.join(', ')}. Valid: ${crmCatalog.KINDS.join(', ')}`);

console.log(`\nL&B CRM catalog — ${APPLY ? 'APPLY' : 'DRY RUN'}`);
console.log(`Location ${config.locationId} · catalog version ${crmCatalog.CRM_CATALOG_VERSION} · kinds: ${kinds.join(', ')}\n`);

function printPlan(summary) {
  const created = summary.plan.filter(entry => entry.action === 'create-product');
  const prices = summary.plan.filter(entry => entry.action === 'create-price');
  const updates = summary.plan.filter(entry => entry.action === 'update-price');

  for (const kind of kinds) {
    const list = crmCatalog.items({ kinds: [kind] });
    const priceCount = list.reduce((total, item) => total + item.prices.length, 0);
    const toCreate = created.filter(entry => entry.kind === kind).length;
    const priceCreate = prices.filter(entry => entry.kind === kind).length;
    console.log(
      `  ${kind.padEnd(11)} ${String(list.length).padStart(3)} products / ${String(priceCount).padStart(3)} prices` +
      ` — ${toCreate} product(s) and ${priceCreate} price(s) to create`
    );
  }
  if (updates.length) console.log(`\n  ${updates.length} price(s) would be corrected to the catalog amount.`);
}

async function writePriceMap(summary, livemode) {
  if (!APPLY || SKIP_DB) return 0;
  if (!process.env.DATABASE_URL) {
    console.log('\n  ! DATABASE_URL is not set — the CRM objects exist but the price map was NOT written.');
    console.log('    Set it and re-run (everything already created is reused), or pass --skip-db deliberately.');
    return 0;
  }
  const { getRepository } = require('../api/_lib/repository.js');
  const repository = getRepository();
  const rows = summary.mapping
    .filter(entry => entry.crmProductId && entry.crmPriceId)
    .map(entry => ({ id: crypto.randomUUID(), catalogVersion: crmCatalog.CRM_CATALOG_VERSION, livemode, ...entry }));
  if (!rows.length) return 0;
  const written = await repository.transaction(['crm-price-map'], async tx => tx.upsertCrmPriceMap(rows));
  await repository.close();
  return written;
}

try {
  const summary = await provisioning.provision({
    config,
    request: ghl.ghlRequest,
    apply: APPLY,
    kinds
  });

  printPlan(summary);

  if (!APPLY) {
    const totals = crmCatalog.summary(crmCatalog.items({ kinds }));
    console.log(`\n  ${totals.products} products, ${totals.prices} prices in scope.`);
    console.log('\nDry run — nothing was created. Re-run with --apply to write to the CRM.\n');
    process.exit(0);
  }

  const { totals } = summary;
  console.log(`\n✓ Products: ${totals.productsCreated} created, ${totals.productsReused} reused.`);
  console.log(`✓ Prices:   ${totals.pricesCreated} created, ${totals.pricesUpdated} corrected, ${totals.pricesReused} reused.`);

  const written = await writePriceMap(summary, Boolean(config.membershipPaymentsLiveMode));
  if (written) console.log(`✓ Price map written: ${written} rows at catalog version ${crmCatalog.CRM_CATALOG_VERSION}.`);

  if (kinds.includes('deposit')) {
    console.log('\n  Note: the location already carries four unmarked deposit products that');
    console.log('  HighLevel created from the calendar payment settings ("… (via calendars)",');
    console.log('  $30/$50). This tool cannot see them, so it created marked ones beside them —');
    console.log('  which means SIX deposit products now exist. Decide which set the office uses');
    console.log('  and archive the other by hand; or re-run without "deposit" in --kinds.');
  }
  console.log('');
} catch (error) {
  fail(`Provisioning failed: ${error.message}`);
}
