#!/usr/bin/env node
// Creates the one opportunity field the member link needs and the sub-account lacks.
//
// The `Memberships` pipeline and the Plan / Vehicle / Status fields already exist. What
// is missing is when the paid cycle RUNS OUT, which is the anchor for counting credits:
// without it the member page falls back to "the last 31 days", which is close but not
// what the customer paid for.
//
// Dry run by default. Creating a field is additive and reversible, but it is still a
// write to the live CRM, so it asks.
//
//   node scripts/setup-membership-fields.mjs           # show what is missing
//   node scripts/setup-membership-fields.mjs --apply   # create it

const BASE_URL = 'https://services.leadconnectorhq.com';
const APPLY = process.argv.includes('--apply');

const token = process.env.GHL_PRIVATE_TOKEN;
const locationId = process.env.GHL_LOCATION_ID;
if (!token || !locationId) {
  console.error('Set GHL_PRIVATE_TOKEN and GHL_LOCATION_ID.');
  process.exit(1);
}

const WANTED = [
  { name: 'Membership Cycle Ends', dataType: 'TEXT' }
];

async function ghl(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      Version: '2021-07-28',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  return { status: response.status, ok: response.ok, body: parsed };
}

const existing = await ghl(`/locations/${locationId}/customFields?model=opportunity`);
if (!existing.ok) {
  console.error(`Could not read custom fields (HTTP ${existing.status})`);
  process.exit(1);
}
const byName = new Set((existing.body.customFields || []).map(field => String(field.name || '').trim()));

const missing = WANTED.filter(field => !byName.has(field.name));
console.log(`opportunity fields present: ${byName.size}`);
for (const field of WANTED) {
  console.log(`  ${byName.has(field.name) ? 'ok      ' : 'MISSING '} ${field.name}`);
}

if (!missing.length) {
  console.log('\nNothing to do.');
  process.exit(0);
}
if (!APPLY) {
  console.log(`\n${missing.length} to create. Re-run with --apply.`);
  process.exit(0);
}

for (const field of missing) {
  const created = await ghl(`/locations/${locationId}/customFields`, {
    method: 'POST',
    body: { name: field.name, dataType: field.dataType, model: 'opportunity' }
  });
  console.log(created.ok
    ? `created ${field.name}`
    : `FAILED  ${field.name} (HTTP ${created.status}) ${JSON.stringify(created.body).slice(0, 160)}`);
}
