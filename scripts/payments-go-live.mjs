// Preflight for switching payments from Stripe TEST mode to LIVE.
//
// Two flags decide whether money is real, and they are deliberately separate so that
// turning on memberships can never disturb the $30/$50 deposits that have been running
// for weeks:
//
//   GHL_DEPOSIT_LIVE_MODE=true      booking deposits charge for real
//   GHL_MEMBERSHIP_LIVE_MODE=true   membership subscriptions charge for real
//
// Neither is read by this script from Vercel — they are marked Sensitive there and come
// back empty — so it reports what the CURRENT PROCESS sees and, more usefully, checks
// everything that has to be true for the live switch not to strand a paying customer.
//
//   node --env-file=.env.probe scripts/payments-go-live.mjs
//
// It only reads. Flipping the flags is a Vercel change; the commands are printed at the
// end so the switch is one copy-paste, not a hunt through a dashboard.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const membershipCatalog = require('../api/_lib/membership-catalog.js');
const provisioning = require('../api/_lib/crm-membership-provisioning.js');

const token = String(process.env.GHL_PRIVATE_TOKEN || '').trim();
const locationId = String(process.env.GHL_LOCATION_ID || '').trim();
if (!token || !locationId) {
  console.error('Faltan GHL_PRIVATE_TOKEN y/o GHL_LOCATION_ID en .env.probe.');
  process.exit(1);
}
const config = { token, locationId };
const BASE = 'https://services.leadconnectorhq.com';

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (detail) console.log(`   ${detail}`);
}

async function get(path, version = 'v3') {
  const res = await fetch(BASE + path, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, Version: version } });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

const REQUIRED_FIELDS = [
  'Membership Plan', 'Membership Vehicle', 'Membership Status', 'Membership Cycle Ends',
  'Membership Portal URL', 'Membership Checkout ID', 'Membership Subscription ID'
];

async function main() {
  console.log(`Preflight de pasaje a LIVE · location ${locationId.slice(0, 6)}…\n`);

  // ── 1. La estructura que el alta exige ───────────────────────────────────
  try {
    const data = await get(`/locations/${encodeURIComponent(locationId)}/customFields?model=opportunity`, '2021-07-28');
    const present = new Set((data.customFields || []).map(f => String(f.name || '').trim()));
    const missing = REQUIRED_FIELDS.filter(n => !present.has(n));
    check('campos personalizados de la membresía', missing.length === 0, missing.length ? `faltan: ${missing.join(', ')}` : `los ${REQUIRED_FIELDS.length} están`);
  } catch (error) { check('campos personalizados de la membresía', false, `no se pudieron leer (${error.message})`); }

  try {
    const data = await get(`/opportunities/pipelines?locationId=${encodeURIComponent(locationId)}`, '2021-07-28');
    const pipeline = (data.pipelines || []).find(p => String(p.name || '').trim().toLowerCase() === 'memberships');
    const stages = pipeline ? (pipeline.stages || []).map(s => String(s.name || '').trim().toLowerCase()) : [];
    const ok = Boolean(pipeline) && stages.includes('pending payment') && stages.includes('active');
    check('pipeline Memberships con Pending Payment y Active', ok, stages.join(' → ') || 'no existe');
  } catch (error) { check('pipeline Memberships', false, error.message); }

  // ── 2. Que TODOS los planes se puedan cobrar, no solo el que se probó ────
  try {
    const listed = await get(`/products/?${new URLSearchParams({ locationId, limit: '100' })}`);
    const products = listed.products || [];
    const entries = membershipCatalog.entries();
    const broken = [];
    for (const packageId of [...new Set(entries.map(e => e.packageId))]) {
      const product = products.find(p => String(p.description || '').includes(provisioning.productMarker(packageId)));
      if (!product) { broken.push(`${packageId}: sin producto`); continue; }
      const prices = (await get(`/products/${encodeURIComponent(product._id || product.id)}/price?${new URLSearchParams({ locationId, limit: '100' })}`)).prices || [];
      for (const entry of entries.filter(e => e.packageId === packageId)) {
        if (!prices.find(p => provisioning.matchingPrice(p, entry))) broken.push(`${entry.packageId}/${entry.sizeId}`);
      }
    }
    check(`los ${entries.length} precios de membresía se resuelven`, broken.length === 0, broken.length ? `sin resolver: ${broken.slice(0, 8).join(', ')}` : 'todos');
  } catch (error) { check('precios de membresía', false, error.message); }

  // ── 3. Nada en modo LIVE que no debería estarlo ──────────────────────────
  try {
    const data = await get(`/invoices/schedule?${new URLSearchParams({ altId: locationId, altType: 'location', limit: '100', offset: '0' })}`);
    const live = (data.schedules || []).filter(s => s.liveMode && s.status !== 'cancelled');
    const drafts = (data.schedules || []).filter(s => s.status === 'draft');
    check('ningún schedule en liveMode fuera de control', live.length === 0,
      live.length ? `⚠️  ${live.length} en liveMode: ${live.map(s => `${s.name} (${s.status})`).join(', ')}` : `${drafts.length} borrador(es), ninguno en live`);
  } catch (error) { check('schedules recurrentes', false, error.message); }

  // ── 4. Config del propio servidor ────────────────────────────────────────
  const publicUrl = String(process.env.PUBLIC_APP_URL || '').trim();
  check('PUBLIC_APP_URL es https', /^https:\/\//.test(publicUrl || 'https://l-b-lyart.vercel.app'),
    publicUrl || 'sin definir (usa el default https://l-b-lyart.vercel.app)');

  // Deliberately NOT reported as if it were production. These variables are Sensitive in
  // Vercel, so nothing local can read what production actually has — and printing this
  // machine's values under a heading like "estado de los interruptores" is exactly how
  // somebody concludes the deposits are in test when they are live, or the reverse.
  console.log(`
── Los interruptores: leelos de PRODUCCIÓN, no de acá ──

   Este script corre en tu máquina y sólo ve tu .env.probe, así que no puede
   decirte en qué modo está el sitio desplegado. Preguntáselo al propio sitio:

   curl -s -H "Authorization: Bearer \\$OFFICE_API_TOKEN" \\
     https://l-b-lyart.vercel.app/api/internal/dependencies | jq .dependencies.payments

   Devuelve depositsEnabled, depositLiveMode y membershipLiveMode tal como los
   ve producción.`);

  const failed = checks.filter(c => !c.ok).length;
  console.log(`\n${checks.length} comprobaciones · ${failed} fallan`);

  if (failed) {
    console.log('\n⛔ NO pasar a live todavía: resolvé lo de arriba primero.');
    process.exitCode = 1;
    return;
  }

  console.log(`
✅ Listo para pasar a live. El cambio es en Vercel (production):

   vercel env rm GHL_MEMBERSHIP_LIVE_MODE production
   printf 'true' | vercel env add GHL_MEMBERSHIP_LIVE_MODE production
   vercel --prod

Para los depósitos de reserva, lo mismo con GHL_DEPOSIT_LIVE_MODE.

Stripe ya está listo: la subcuenta tiene los DOS modos habilitados, live y test,
y es el proveedor Default (verificado el 5 ago 2026 en Payments → Integrations →
Stripe → Manage). Por eso estos flags son lo ÚNICO que decide si la plata es
real: cada factura se emite contra uno u otro modo según su liveMode.

Lo que no cambia al pasar a live: el primer ciclo SIEMPRE es una factura que el
miembro paga a mano por email. El cobro automático se enciende recién con esa
primera tarjeta guardada (api/payments/webhook.js), porque HighLevel exige un
saved_card que hasta ese momento no existe.
`);
}

main().catch(error => {
  console.error('El preflight se cayó:', error.message);
  process.exitCode = 1;
});
