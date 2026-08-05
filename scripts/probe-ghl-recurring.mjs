// Read-only probe of everything the membership enrollment flow assumes about
// HighLevel, run against the real sub-account.
//
// PANORAMA.md §6.1 asked for this before the checkout moved to /invoices/schedule, and
// it never happened: the ten commits before the enrollment landed are consecutive
// corrections to that same contract, which is what an unverified API looks like from
// the outside. This script answers the questions those commits were guessing at.
//
// It NEVER writes. Every call is a GET. The write-side questions — what POST
// /invoices/schedule returns, and whether PUT /opportunities/{id} merges or replaces
// custom fields — need their own probe with explicit consent, because both of them
// create or mutate real objects in a live CRM.
//
// It also never prints a secret, a customer, or a full response body: only shapes,
// counts and the specific keys the code branches on. The output is meant to be safe to
// paste anywhere.
//
// The credentials cannot come from `vercel env pull`: every secret in this project is
// marked Sensitive in Vercel, and the CLI returns those as empty strings. Put the three
// values in site/.env.probe (gitignored by the `.env*` rule) and run:
//
//   node --env-file=.env.probe scripts/probe-ghl-recurring.mjs
//
// .env.probe needs exactly:
//   GHL_PRIVATE_TOKEN=…
//   GHL_LOCATION_ID=…
//   GHL_ASSIGNED_USER_ID=…

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const ghl = require('../api/_lib/ghl.js');
const recurring = require('../api/_lib/crm-recurring-memberships.js');
const membershipCatalog = require('../api/_lib/membership-catalog.js');
const provisioning = require('../api/_lib/crm-membership-provisioning.js');

// Built by hand rather than through ghl.getConfig(), which also demands the assigned
// user and the four van calendars. None of that is read here, and every extra variable
// is another thing that has to be right before a probe can even start.
const config = {
  token: String(process.env.GHL_PRIVATE_TOKEN || '').trim(),
  locationId: String(process.env.GHL_LOCATION_ID || '').trim(),
  assignedUserId: String(process.env.GHL_ASSIGNED_USER_ID || '').trim()
};
if (!config.token || !config.locationId) {
  console.error('Faltan GHL_PRIVATE_TOKEN y/o GHL_LOCATION_ID en .env.probe.');
  process.exit(1);
}

const results = [];

function report(question, verdict, detail) {
  results.push({ question, verdict, detail });
  const mark = verdict === 'ok' ? '✅' : verdict === 'warn' ? '⚠️ ' : '❌';
  console.log(`${mark} ${question}`);
  if (detail) console.log(`   ${detail}`);
}

// The shape of an envelope, without its contents: which key holds the list, and how
// each row names its id. That is exactly what findScheduleByReference branches on.
function describeEnvelope(data) {
  if (Array.isArray(data)) return { key: '<array>', count: data.length, rows: data };
  for (const key of ['schedules', 'data', 'invoiceSchedules', 'items', 'results']) {
    if (Array.isArray(data && data[key])) return { key, count: data[key].length, rows: data[key] };
  }
  return { key: null, count: 0, rows: [], topLevelKeys: Object.keys(data || {}) };
}

async function get(path, version) {
  return ghl.ghlRequest(config, path, { version, diagnostic: true });
}

// ── 1. Does the recurring-schedule endpoint exist, and what does it return? ──
async function probeScheduleList() {
  const query = new URLSearchParams({ altId: config.locationId, altType: 'location', limit: '100', offset: '0' });
  let data;
  try {
    // v3, not the dated create version: the read endpoints are served under v3.
    data = await get(`/invoices/schedule?${query}`, 'v3');
  } catch (error) {
    report('GET /invoices/schedule responde', 'fail',
      `${error.name} ${error.statusCode || ''} ${error.hint || ''} ${error.detail || ''}`.trim());
    return null;
  }

  const envelope = describeEnvelope(data);
  if (!envelope.key) {
    report('GET /invoices/schedule responde', 'warn',
      `200 pero sin lista reconocible. Claves de primer nivel: ${(envelope.topLevelKeys || []).join(', ') || '(ninguna)'}`);
    return envelope;
  }

  report('GET /invoices/schedule responde', 'ok', `envelope: "${envelope.key}", ${envelope.count} schedule(s)`);

  // findScheduleByReference reads _id or id, and matches on `name`. Confirm both exist.
  const sample = envelope.rows[0];
  if (sample) {
    const idKey = sample._id ? '_id' : sample.id ? 'id' : null;
    report('cada schedule trae id y name', idKey && sample.name !== undefined ? 'ok' : 'warn',
      `id en "${idKey || 'NINGUNO'}", name ${sample.name === undefined ? 'AUSENTE' : 'presente'}, ` +
      `claves: ${Object.keys(sample).slice(0, 14).join(', ')}`);
  } else {
    report('cada schedule trae id y name', 'warn', 'la cuenta no tiene ningún schedule todavía; no hay fila para inspeccionar');
  }

  // Did the earlier enrollment work ever create one? A schedule named after a contract
  // would mean money is already scheduled against a customer.
  const ours = envelope.rows.filter(row => String(row && row.name || '').startsWith('L&B Membership —'));
  report('schedules ya creados por el alta web', ours.length ? 'warn' : 'ok',
    ours.length
      ? `${ours.length} con el nombre del alta — REVISAR si alguno cobra de verdad`
      : 'ninguno: el alta nunca corrió contra esta cuenta');

  return envelope;
}

// ── 2. ¿Existen los campos personalizados que el alta exige? ────────────────
const REQUIRED_FIELDS = [
  'Membership Plan', 'Membership Vehicle', 'Membership Status',
  'Membership Cycle Ends', 'Membership Portal URL', 'Membership Checkout ID',
  'Membership Subscription ID'
];

async function probeCustomFields() {
  const data = await get(`/locations/${encodeURIComponent(config.locationId)}/customFields?model=opportunity`, '2021-07-28');
  const present = new Set((data.customFields || []).map(field => String(field.name || '').trim()));
  const missing = REQUIRED_FIELDS.filter(name => !present.has(name));
  report('campos personalizados de oportunidad', missing.length ? 'fail' : 'ok',
    missing.length
      ? `faltan ${missing.length}: ${missing.join(', ')} → correr scripts/setup-membership-fields.mjs`
      : `los ${REQUIRED_FIELDS.length} están creados`);
  return missing;
}

// ── 3. ¿Existen el pipeline y la etapa que enrollmentMetadata exige? ────────
async function probePipeline() {
  const data = await get(`/opportunities/pipelines?locationId=${encodeURIComponent(config.locationId)}`, '2021-07-28');
  const pipeline = (data.pipelines || []).find(item => String(item.name || '').trim().toLowerCase() === 'memberships');
  if (!pipeline) {
    report('pipeline "Memberships"', 'fail',
      `no existe. Pipelines: ${(data.pipelines || []).map(p => p.name).join(', ') || '(ninguno)'}`);
    return;
  }
  const stages = (pipeline.stages || []).map(stage => String(stage.name || '').trim());
  const pending = stages.find(name => name.toLowerCase() === 'pending payment');
  report('pipeline "Memberships" y etapa "Pending Payment"', pending ? 'ok' : 'fail',
    `etapas: ${stages.join(' → ') || '(ninguna)'}`);
}

// ── 4. ¿El producto y el precio que resolveItem busca existen de verdad? ────
//
// resolveItem lista productos, encuentra el de la membresía por su marcador en la
// descripción, lista sus precios y elige el que coincide en importe y cadencia. Si
// cualquiera de esos pasos falla, el alta muere con 503 y el cliente no ve nada.
async function probeCatalog() {
  const listed = await get(`/products/?${new URLSearchParams({ locationId: config.locationId, limit: '100' })}`, 'v3');
  const products = Array.isArray(listed && listed.products) ? listed.products : [];
  report('productos visibles en la subcuenta', 'ok', `${products.length}`);

  const entries = membershipCatalog.entries();
  const packageIds = [...new Set(entries.map(entry => entry.packageId))];
  const resolvable = [];
  const broken = [];

  for (const packageId of packageIds) {
    const marker = provisioning.productMarker(packageId);
    const product = products.find(candidate => String(candidate && candidate.description || '').includes(marker));
    if (!product) { broken.push(`${packageId}: sin producto`); continue; }

    const productId = product._id || product.id;
    const priceData = await get(`/products/${encodeURIComponent(productId)}/price?${new URLSearchParams({ locationId: config.locationId, limit: '100' })}`, 'v3');
    const prices = Array.isArray(priceData && priceData.prices) ? priceData.prices : [];

    for (const entry of entries.filter(candidate => candidate.packageId === packageId)) {
      const price = prices.find(candidate => provisioning.matchingPrice(candidate, entry));
      if (price) resolvable.push(`${entry.packageId}/${entry.sizeId}`);
      else broken.push(`${entry.packageId}/${entry.sizeId}: producto sí, precio no ($${provisioning.crmAmount(entry)})`);
    }
  }

  report('planes de membresía que el alta puede cobrar', broken.length ? 'fail' : 'ok',
    `${resolvable.length} de ${entries.length} resolubles` +
    (broken.length ? `\n   sin resolver:\n     ${broken.slice(0, 12).join('\n     ')}` : ''));
}

// ── 5. ¿La factura de efectivo de la cuadrilla puede existir siquiera? ──────
//
// createCashInvoice crea la factura SIN action:send (queda en borrador) y después le
// registra el pago. Que HighLevel acepte un pago sobre un borrador no está probado.
// No se puede confirmar sin escribir, así que esto sólo comprueba que el endpoint de
// facturas responde y deja la pregunta anotada.
async function probeInvoicesReachable() {
  try {
    await get(`/invoices/?${new URLSearchParams({ altId: config.locationId, altType: 'location', limit: '1', offset: '0' })}`, 'v3');
    report('API de facturas alcanzable', 'ok', 'GET /invoices/ responde 200');
  } catch (error) {
    report('API de facturas alcanzable', 'fail', `${error.name} ${error.statusCode || ''}`);
  }
}

async function main() {
  console.log(`Sondeo de solo lectura · location ${config.locationId.slice(0, 6)}… · ${new Date().toISOString()}\n`);

  await probeScheduleList();
  await probeCustomFields();
  await probePipeline();
  await probeCatalog();
  await probeInvoicesReachable();

  const failed = results.filter(entry => entry.verdict === 'fail').length;
  const warned = results.filter(entry => entry.verdict === 'warn').length;
  console.log(`\n${results.length} comprobaciones · ${failed} fallan · ${warned} con reparo`);
  process.exitCode = failed ? 1 : 0;
}

main().catch(error => {
  console.error('El sondeo se cayó:', error.name, error.statusCode || '', error.hint || '');
  process.exitCode = 1;
});
