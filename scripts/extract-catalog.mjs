#!/usr/bin/env node
// Regenerates api/_lib/catalog-prices.json from the SERVICES_DATA literal in
// script.js, which is where the owner edits prices.
//
// The server must never trust a price, duration or membership flag posted by the
// browser (see the "no browser-supplied money" rule in api/_lib/pricing.js), so
// it needs its own copy of the catalog. Keeping that copy GENERATED instead of
// hand-maintained means a price change in script.js can't silently drift away
// from what the API charges: re-run this script and the diff shows up in review.
//
//   node scripts/extract-catalog.mjs          # write the JSON
//   node scripts/extract-catalog.mjs --check  # fail if the JSON is stale (CI)

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const siteDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = join(siteDir, 'script.js');
const outputPath = join(siteDir, 'api', '_lib', 'catalog-prices.json');
const publicOutputPath = join(siteDir, 'api', '_lib', 'catalog-public.json');

// Pulls a top-level `const NAME = <literal>;` out of script.js by brace/bracket
// matching, so we can evaluate just that literal instead of the whole IIFE
// (which needs a DOM).
function extractLiteral(source, name) {
  const marker = [`const ${name} = `, `let ${name} = `].find(candidate => source.includes(candidate));
  const declaration = marker ? source.indexOf(marker) : -1;
  if (declaration === -1) throw new Error(`${name} not found in script.js`);
  const start = declaration + marker.length;
  const openIndex = source.slice(start).search(/[[{(]/);
  if (openIndex === -1) throw new Error(`${name} is not an object/array literal`);
  const from = start + openIndex;
  const pairs = { '{': '}', '[': ']', '(': ')' };
  const stack = [];
  for (let index = from; index < source.length; index += 1) {
    const char = source[index];
    if (char === "'" || char === '"' || char === '`') {
      index = skipString(source, index);
      continue;
    }
    if (pairs[char]) stack.push(pairs[char]);
    else if (char === '}' || char === ']' || char === ')') {
      if (stack.pop() !== char) throw new Error(`Unbalanced literal for ${name}`);
      if (!stack.length) return source.slice(from, index + 1);
    }
  }
  throw new Error(`Unterminated literal for ${name}`);
}

function skipString(source, openIndex) {
  const quote = source[openIndex];
  for (let index = openIndex + 1; index < source.length; index += 1) {
    if (source[index] === '\\') index += 1;
    else if (source[index] === quote) return index;
  }
  throw new Error('Unterminated string literal');
}

const source = readFileSync(scriptPath, 'utf8');
// Parenthesized so a leading `{` evaluates as an object literal, not a block.
function evaluateLiteral(name, sandbox = {}) {
  return vm.runInNewContext(`(${extractLiteral(source, name)})`, { Object, ...sandbox });
}

const carHaulerIds = evaluateLiteral('CAR_HAULER_PACKAGE_IDS');
const servicesData = evaluateLiteral('SERVICES_DATA', { CAR_HAULER_PACKAGE_IDS: carHaulerIds });

// Only the fields that decide money or eligibility. Names, descriptions, images
// and copy stay in the frontend: the server has no business rendering them, and
// leaving them out keeps this file reviewable.
const catalog = {
  // A note for whoever opens the generated file wondering where it came from.
  _generated: 'scripts/extract-catalog.mjs — do not edit by hand',
  categories: servicesData.categories.map(category => ({
    id: category.id,
    sizes: Array.isArray(category.sizes)
      ? category.sizes.map(size => size.id)
      // Heavy trucks keep sizes keyed per package group.
      : Object.fromEntries(Object.entries(category.sizes || {}).map(([group, sizes]) => [group, sizes.map(size => size.id)])),
    packages: (category.packages || []).map(pkg => ({
      id: pkg.id,
      ...(pkg.group ? { group: pkg.group } : {}),
      prices: pkg.prices || {},
      ...(pkg.priceRanges ? { priceRanges: pkg.priceRanges } : {})
    })),
    addons: (category.extras || []).map(addon => ({
      id: addon.id,
      price: Number(addon.price || 0),
      ...(addon.range ? { range: addon.range } : {}),
      ...(addon.onlyFor ? { onlyFor: [...addon.onlyFor] } : {}),
      ...(addon.notForGroups ? { notForGroups: [...addon.notForGroups] } : {})
    }))
  }))
};

const serialized = `${JSON.stringify(catalog, null, 2)}\n`;
// The browser hydrates its rendering metadata from this same generated source.
// It deliberately contains ids and display data only; every monetary decision
// is still recomputed by pricing.js when a request arrives.
const publicCatalog = {
  _generated: 'scripts/extract-catalog.mjs — do not edit by hand',
  version: '1',
  categories: servicesData.categories
};
const publicSerialized = `${JSON.stringify(publicCatalog, null, 2)}\n`;

if (process.argv.includes('--check')) {
  let current = '';
  try { current = readFileSync(outputPath, 'utf8'); } catch { /* missing counts as stale */ }
  let publicCurrent = '';
  try { publicCurrent = readFileSync(publicOutputPath, 'utf8'); } catch { /* missing counts as stale */ }
  if (current !== serialized || publicCurrent !== publicSerialized) {
    console.error('catalog files are stale — run: node scripts/extract-catalog.mjs');
    process.exit(1);
  }
  console.log('catalog-prices.json is up to date');
} else {
  writeFileSync(outputPath, serialized);
  writeFileSync(publicOutputPath, publicSerialized);
  const packages = catalog.categories.reduce((total, category) => total + category.packages.length, 0);
  const addons = catalog.categories.reduce((total, category) => total + category.addons.length, 0);
  console.log(`wrote ${outputPath} (${catalog.categories.length} categories, ${packages} packages, ${addons} add-ons)`);
}
