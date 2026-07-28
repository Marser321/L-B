#!/usr/bin/env node
// Creates the membership catalogue in Stripe: 17 Products, 33 recurring Prices,
// and the versioned packageId + sizeId → stripePriceId map in Postgres.
//
//   node scripts/provision-stripe.mjs                 # dry run (default)
//   node scripts/provision-stripe.mjs --apply         # test mode, writes
//   node scripts/provision-stripe.mjs --apply --live --i-understand-live
//
// Three deliberate frictions:
//
//   * **Dry run is the default.** You have to type --apply. A bare run prints
//     exactly what it would create and touches nothing.
//   * **Live needs two more flags.** A live secret key alone is not consent;
//     creating live products is how a business ends up charging real cards from a
//     half-finished catalogue.
//   * **It never edits anything it did not create.** Objects are matched by our
//     own lookup keys and must carry `metadata.lyb_object = lyb_membership`.
//     Anything else — including the existing $30/$50 deposit products — is left
//     strictly alone, and a name collision is an error rather than an update.
//
// Re-running is safe: existing membership products and prices are reused, and only
// missing ones are created. Stripe prices are immutable, so a changed amount
// creates a NEW price and leaves the old one for existing subscriptions; bump
// CATALOG_VERSION in membership-catalog.js when that happens.

import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const membershipCatalog = require('../api/_lib/membership-catalog.js');
const stripeClient = require('../api/_lib/stripe.js');
// The decide-what-to-create logic lives in a module so it can be tested without
// a Stripe account; see tests/stripe-provisioning.test.js.
const provisioning = require('../api/_lib/stripe-provisioning.js');

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const LIVE = args.has('--live');
const LIVE_CONFIRMED = args.has('--i-understand-live');
const SKIP_DB = args.has('--skip-db');

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

const secretKey = String(process.env.STRIPE_SECRET_KEY || '').trim();
if (!secretKey) fail('Set STRIPE_SECRET_KEY (use a test key unless you really mean live).');
const keyIsLive = secretKey.startsWith('sk_live_');

// Guard rails around live mode, in both directions.
if (keyIsLive && !LIVE) {
  fail('STRIPE_SECRET_KEY is a LIVE key. Re-run with --live --i-understand-live, or use a test key.');
}
if (LIVE && !keyIsLive) {
  fail('--live was passed but STRIPE_SECRET_KEY is not a live key.');
}
if (LIVE && APPLY && !LIVE_CONFIRMED) {
  fail('Refusing to create LIVE products without --i-understand-live.');
}

const stripe = {
  secretKey,
  livemode: keyIsLive,
  webhookSecret: '',
  successUrl: '',
  cancelUrl: ''
};

const mode = APPLY ? (keyIsLive ? 'APPLY · LIVE' : 'APPLY · test') : 'DRY RUN';
console.log(`\nL&B membership provisioning — ${mode}`);
console.log(`Catalog version ${membershipCatalog.CATALOG_VERSION}\n`);


// ── Look at what is already there ──────────────────────────────────────────

// Pages through everything in the account. Objects that are not ours are read and
// discarded here; the planner never sees them.
async function loadExisting() {
  const products = [];
  const prices = [];

  let startingAfter = null;
  do {
    const page = await stripeClient.listProducts(stripe, {
      ...(startingAfter ? { starting_after: startingAfter } : {})
    });
    products.push(...(page.data || []));
    startingAfter = page.has_more && page.data.length ? page.data[page.data.length - 1].id : null;
  } while (startingAfter);

  startingAfter = null;
  do {
    const page = await stripeClient.listPrices(stripe, {
      ...(startingAfter ? { starting_after: startingAfter } : {})
    });
    prices.push(...(page.data || []));
    startingAfter = page.has_more && page.data.length ? page.data[page.data.length - 1].id : null;
  } while (startingAfter);

  return { products, prices };
}

// ── Apply ──────────────────────────────────────────────────────────────────

async function createProducts(plan) {
  for (const item of plan) {
    if (item.action !== 'create') continue;
    if (!APPLY) { item.stripeProductId = `(dry-run:${item.lookupKey})`; continue; }
    const product = await stripeClient.createProduct(stripe, {
      name: item.label,
      metadata: membershipCatalog.metadataFor({ packageId: item.packageId })
    }, `product:${item.lookupKey}`);
    item.stripeProductId = product.id;
    console.log(`  created product ${product.id}  ${item.label}`);
  }
}

async function createPrices(plan, products) {
  const productByPackage = new Map(products.map(product => [product.packageId, product]));
  for (const item of plan) {
    if (item.action !== 'create') continue;
    const product = productByPackage.get(item.packageId);
    if (!APPLY) { item.stripePriceId = `(dry-run:${item.lookupKey})`; item.stripeProductId = product.stripeProductId; continue; }
    const price = await stripeClient.createPrice(stripe, {
      product: product.stripeProductId,
      currency: item.currency,
      unit_amount: item.monthlyCents,
      recurring: { interval: item.interval },
      lookup_key: item.lookupKey,
      nickname: item.priceLabel,
      metadata: membershipCatalog.metadataFor(item)
    }, `price:${item.lookupKey}`);
    item.stripePriceId = price.id;
    item.stripeProductId = product.stripeProductId;
    console.log(`  created price   ${price.id}  ${item.priceLabel}  $${(item.monthlyCents / 100).toFixed(2)}/mo`);
  }
}

async function writePriceMap(plan) {
  if (!APPLY || SKIP_DB) return 0;
  if (!process.env.DATABASE_URL) {
    console.log('\n  ! DATABASE_URL is not set — Stripe objects exist but the price map was NOT written.');
    console.log('    Set it and re-run (existing objects are reused), or pass --skip-db deliberately.');
    return 0;
  }
  const { getRepository } = require('../api/_lib/repository.js');
  const repository = getRepository();
  const rows = plan.map(item => ({
    id: crypto.randomUUID(),
    catalogVersion: membershipCatalog.CATALOG_VERSION,
    packageId: item.packageId,
    sizeId: item.sizeId,
    monthlyCents: item.monthlyCents,
    currency: item.currency,
    creditsPerCycle: item.creditsPerCycle,
    stripeProductId: item.stripeProductId,
    stripePriceId: item.stripePriceId,
    lookupKey: item.lookupKey,
    livemode: stripe.livemode
  }));
  const written = await repository.transaction(['membership-price-map'], async tx => tx.upsertPriceMapEntries(rows));
  await repository.close();
  return written;
}

// ── Run ────────────────────────────────────────────────────────────────────

try {
  const existing = await loadExisting();
  const { productPlan, pricePlan, summary } = provisioning.plan(existing);

  console.log(`Products: ${summary.products.total} total — ${summary.products.create} to create, ${summary.products.reuse} already present`);
  console.log(`Prices:   ${summary.prices.total} total — ${summary.prices.create} to create, ${summary.prices.reuse} already present\n`);

  if (!APPLY) {
    for (const item of pricePlan) {
      const marker = item.action === 'create' ? '+' : '=';
      console.log(`  ${marker} ${item.packageId.padEnd(20)} ${item.sizeId.padEnd(14)} $${String(item.monthlyCents / 100).padStart(6)}/mo  ${item.creditsPerCycle} credits  ${item.lookupKey}`);
    }
    const total = pricePlan.reduce((sum, item) => sum + item.monthlyCents, 0);
    console.log(`\n  ${pricePlan.length} prices, ${(total / 100).toFixed(2)} total if one of each were sold.`);
    console.log('\nDry run — nothing was created. Re-run with --apply to write to Stripe.\n');
    process.exit(0);
  }

  await createProducts(productPlan);
  await createPrices(pricePlan, productPlan);
  const written = await writePriceMap(pricePlan);

  console.log(`\n✓ Stripe catalogue ready: ${productPlan.length} products, ${pricePlan.length} prices.`);
  if (written) console.log(`✓ Price map written: ${written} rows at catalog version ${membershipCatalog.CATALOG_VERSION} (${stripe.livemode ? 'live' : 'test'} mode).`);
  console.log('\nThe existing $30/$50 deposit products were not read, edited or replaced.\n');
} catch (error) {
  console.error(`\n✗ Provisioning failed: ${error.message}\n`);
  process.exit(1);
}
