'use strict';

// Planning logic for scripts/provision-stripe.mjs, kept out of the script so it
// can be tested without touching Stripe.
//
// The rule this file exists to enforce: **we only ever create or reuse objects we
// created.** The sub-account already carries the $30/$50 deposit products, and the
// office may add more by hand. Nothing here edits, renames, deactivates or reuses
// an object that is not stamped with our membership metadata — a collision is an
// error that stops the run, not something to resolve by overwriting.

const membershipCatalog = require('./membership-catalog.js');

class ProvisioningError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProvisioningError';
  }
}

// Indexes what Stripe already has. Products are matched on our own metadata key
// and prices on our own lookup key, so an object without either is invisible here
// — which is exactly how the deposit products stay out of reach.
function indexExisting({ products = [], prices = [] } = {}) {
  const byPackage = new Map();
  for (const product of products) {
    const packageId = product.metadata && product.metadata.lyb_package_id;
    if (packageId) byPackage.set(packageId, product);
  }
  const byLookupKey = new Map();
  for (const price of prices) {
    if (price.lookup_key) byLookupKey.set(price.lookup_key, price);
  }
  return { byPackage, byLookupKey };
}

function planProducts(existing) {
  return membershipCatalog.products().map(entry => {
    const found = existing.byPackage.get(entry.packageId);
    if (!found) return { ...entry, action: 'create', stripeProductId: null };
    // It claims one of our package ids. If it is not ours, someone else's object
    // is wearing our label — stop rather than adopt it.
    if (!membershipCatalog.isOurs(found)) {
      throw new ProvisioningError(
        `Product ${found.id} carries lyb_package_id=${entry.packageId} but is not marked as a membership object. Refusing to touch it.`
      );
    }
    return { ...entry, action: 'reuse', stripeProductId: found.id };
  });
}

function planPrices(existing, productPlan) {
  const productByPackage = new Map(productPlan.map(product => [product.packageId, product]));
  return membershipCatalog.entries().map(entry => {
    const product = productByPackage.get(entry.packageId);
    const found = existing.byLookupKey.get(entry.lookupKey);
    if (!found) {
      return { ...entry, action: 'create', stripePriceId: null, stripeProductId: product ? product.stripeProductId : null };
    }
    if (!membershipCatalog.isOurs(found)) {
      throw new ProvisioningError(
        `Price ${found.id} uses our lookup key ${entry.lookupKey} but is not marked as a membership object. Refusing to touch it.`
      );
    }
    // Stripe prices are immutable by design. A mismatch means the catalogue moved
    // and nobody bumped the version, so existing subscribers and new ones would
    // silently be on different amounts.
    if (found.unit_amount !== entry.monthlyCents) {
      throw new ProvisioningError(
        `Price ${found.id} (${entry.lookupKey}) is ${found.unit_amount} but the catalog says ${entry.monthlyCents}. ` +
        'Stripe prices cannot be edited — bump CATALOG_VERSION in membership-catalog.js and re-run.'
      );
    }
    return { ...entry, action: 'reuse', stripePriceId: found.id, stripeProductId: found.product };
  });
}

function summarize(productPlan, pricePlan) {
  const newProducts = productPlan.filter(item => item.action === 'create').length;
  const newPrices = pricePlan.filter(item => item.action === 'create').length;
  return {
    products: { total: productPlan.length, create: newProducts, reuse: productPlan.length - newProducts },
    prices: { total: pricePlan.length, create: newPrices, reuse: pricePlan.length - newPrices },
    totalMonthlyCents: pricePlan.reduce((sum, item) => sum + item.monthlyCents, 0)
  };
}

// Everything needed to decide what to do, from a snapshot of the account.
function plan(existingSnapshot) {
  const existing = indexExisting(existingSnapshot);
  const productPlan = planProducts(existing);
  const pricePlan = planPrices(existing, productPlan);
  return { productPlan, pricePlan, summary: summarize(productPlan, pricePlan) };
}

module.exports = { ProvisioningError, indexExisting, planProducts, planPrices, summarize, plan };
