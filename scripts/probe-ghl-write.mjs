// Write probe, in TEST mode, of the two contracts the enrollment flow depends on and
// nobody has ever verified against the real sub-account.
//
// The read probe (probe-ghl-recurring.mjs) established that the structure is all there
// and that nothing has ever billed a customer. What it could not answer is what happens
// when you actually write:
//
//   A. Does POST /invoices/schedule → POST /invoices/schedule/{id}/schedule actually
//      ACTIVATE the subscription, and does a payable URL ever come back? The four
//      schedules sitting in the account are all Draft, which is exactly what a flow
//      that never called the activation step leaves behind. Until this runs, there is
//      no evidence that an enrolled membership ever charges anybody.
//
//   B. Does PUT /opportunities/{id} MERGE custom fields or REPLACE the list? Every
//      write in this codebase sends only the fields it is changing. If the API
//      replaces, `grantCycle` silently wipes the plan and the vehicle, and the
//      enrollment wipes the checkout id that makes retries idempotent — which would
//      turn one contract into two.
//
// ── Safety ────────────────────────────────────────────────────────────────────
//
//   · Refuses to run if GHL_MEMBERSHIP_LIVE_MODE=true. Everything it creates is
//     liveMode:false, which is Stripe's test mode: no real money can move.
//   · Refuses to run without --apply. The default prints the plan and exits.
//   · Everything it creates is DELETED in a finally block, and every created id is
//     printed as it happens, so anything the cleanup misses can be removed by hand.
//   · It touches one dedicated contact and one throwaway opportunity. It never reads,
//     writes or deletes a real customer's anything.
//
//   node --env-file=.env.probe scripts/probe-ghl-write.mjs            # plan only
//   node --env-file=.env.probe scripts/probe-ghl-write.mjs --apply    # run it

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const ghl = require('../api/_lib/ghl.js');
const recurring = require('../api/_lib/crm-recurring-memberships.js');

const APPLY = process.argv.includes('--apply');
const KEEP = process.argv.includes('--keep');

// The plan and size the probe bills. Any real membership entry works; this one is the
// cheapest, which keeps the test-mode invoice unremarkable.
const PACKAGE_ID = 'membresia-2x';
const SIZE_ID = 'sedan';
const TEST_CONTACT = {
  name: 'L&B CRM Billing Test',
  email: 'crm-billing-test@lbelitewashd.com',
  phone: '+12395270770'
};

const created = { scheduleId: '', libScheduleId: '', opportunityId: '' };

function line(text = '') { console.log(text); }
function step(title) { line(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`); }

// Keys only, never values: a response can echo the contact and the invoice.
function shape(value, depth = 0) {
  if (Array.isArray(value)) return `[${value.length}×${value.length ? shape(value[0], depth + 1) : '?'}]`;
  if (value && typeof value === 'object') {
    if (depth > 1) return '{…}';
    return `{${Object.keys(value).slice(0, 18).join(', ')}}`;
  }
  return typeof value;
}

// Top level FIRST — same trap as the id: this API's `schedule` key holds the rrule, so
// descending into it loses the status that is sitting right there on the response.
function statusOf(value) {
  if (!value || typeof value !== 'object') return '(sin respuesta)';
  const direct = value.status || value.state;
  if (direct) return String(direct);
  for (const key of ['invoiceSchedule', 'data', 'result']) {
    const nested = value[key] && (value[key].status || value[key].state);
    if (nested) return String(nested);
  }
  return '(sin campo status)';
}

async function probeRecurring(config) {
  step('A · POST /invoices/schedule → activación → link de pago');

  const item = await recurring.resolveItem({
    config, request: ghl.ghlRequest, packageId: PACKAGE_ID, sizeId: SIZE_ID,
    vehicleLabel: 'PROBE — borrar', requestId: 'probe-write'
  });
  line(`   producto/precio resueltos: $${item.amount}/mes, type=${item.type}`);

  const contact = await ghl.upsertContact(config, TEST_CONTACT);
  line(`   contacto de prueba: ${contact.id}`);

  // The payload the code builds today is rejected 422. Rather than guess, walk a ladder
  // of variants from what the CODE sends towards what the deleted probe endpoint sent —
  // the latter demonstrably worked, since the four drafts in the account are its output.
  // The first variant that is accepted names the field that was wrong.
  const DAY = 24 * 60 * 60 * 1000;
  const variants = [
    ['tal cual lo manda el código hoy', {}],
    ['+ startDate a 48 h (lo que hacía el probe viejo)', { now: Date.now() + 2 * DAY }],
    ['+ dayOfMonth: 1 fijo', { dayOfMonth: 1 }],
    ['+ startDate 48 h Y dayOfMonth: 1', { now: Date.now() + 2 * DAY, dayOfMonth: 1 }],
    ['+ además title/prefijo del probe viejo', { now: Date.now() + 2 * DAY, dayOfMonth: 1, title: 'INVOICE', invoiceNumberPrefix: 'INV-' }]
  ];

  let draft = null;
  let reference = '';
  let winner = '';
  for (const [label, tweak] of variants) {
    const attempt = `probe-write-${Date.now().toString(36)}`;
    const body = recurring.schedulePayload({
      config, contact: { ...TEST_CONTACT, id: contact.id }, item, reference: attempt,
      now: tweak.now || Date.now(), liveMode: false, timeZone: 'America/New_York'
    });
    if (tweak.dayOfMonth) body.schedule.rrule.dayOfMonth = tweak.dayOfMonth;
    if (tweak.title) body.title = tweak.title;
    if (tweak.invoiceNumberPrefix) body.invoiceNumberPrefix = tweak.invoiceNumberPrefix;

    try {
      draft = await ghl.ghlRequest(config, '/invoices/schedule', {
        method: 'POST', version: recurring.INVOICE_VERSION, requestId: attempt, diagnostic: true, body
      });
      reference = attempt;
      winner = label;
      line(`   ✅ ${label}`);
      break;
    } catch (error) {
      line(`   ❌ ${label} → ${error.upstreamStatus || error.statusCode} ${error.upstreamHint || ''} ${error.diagnosticMessage || ''}`);
    }
  }

  if (!draft) { line('\n   ⇒ ninguna variante fue aceptada. El contrato cambió más de lo previsto.'); return; }
  line(`\n   ⇒ LA CORRECCIÓN ES: ${winner}`);
  line(`   1) crear  → ${shape(draft)}`);

  // This mirrors idOf() in the library: if the id is not where the code looks for it,
  // createAndSchedule throws MEMBERSHIP_SCHEDULE_FAILED and the customer sees nothing.
  const scheduleId = recurring.scheduleIdFrom(draft);
  if (!scheduleId) {
    line('   ❌ el id NO está donde el código lo busca. createAndSchedule fallaría acá.');
    return;
  }
  created.scheduleId = scheduleId;
  line(`   ✅ id encontrado: ${scheduleId}`);
  line(`      estado tras crear: ${statusOf(draft)}`);
  line(`      ¿link de pago ya? ${recurring.payableUrl(draft) ? 'SÍ' : 'no'}`);

  // The step that has never run. If this is what moves a schedule out of Draft, the
  // enrollment works; if it does not, an enrolled member never gets charged.
  let activated = null;
  try {
    // The same body createAndSchedule sends. An empty one is answered 422 naming these
    // three fields — which is how they were discovered in the first place.
    activated = await ghl.ghlRequest(config, `/invoices/schedule/${encodeURIComponent(scheduleId)}/schedule`, {
      method: 'POST', version: recurring.INVOICE_VERSION, requestId: reference, diagnostic: true,
      body: { altId: config.locationId, altType: 'location', liveMode: false, autoPayment: { enable: false } }
    });
    line(`   2) activar → ${shape(activated)}`);
    line(`      estado tras activar: ${statusOf(activated)}`);
    line(`      ¿link de pago? ${recurring.payableUrl(activated) ? 'SÍ' : 'no'}`);
  } catch (error) {
    line(`   ❌ 2) activar FALLÓ: ${error.name} ${error.statusCode || ''} ${error.upstreamHint || ""} ${error.diagnosticMessage || ""}`);
  }

  // And what the CRM says about it afterwards, read the way the code reads it.
  const fetched = await ghl.ghlRequest(config, `/invoices/schedule/${encodeURIComponent(scheduleId)}?${new URLSearchParams({ altId: config.locationId, altType: "location" })}`, {
    version: 'v3', requestId: reference
  });
  line(`   3) releer  → estado final: ${statusOf(fetched)}`);
  const url = recurring.payableUrl(fetched) || recurring.payableUrl(activated) || recurring.payableUrl(draft);
  line(`      link de pago final: ${url ? 'SÍ — ' + new URL(url).origin + '/…' : 'NINGUNO'}`);

  const sentTo = activated && activated.sentTo;
  line('');
  line(url
    ? '   ⇒ el alta le devuelve un link de pago al cliente.'
    : `   ⇒ no hay link en la respuesta; HighLevel MANDA la factura (campo sentTo: ${sentTo ? 'presente' : 'ausente'}).`);
  if (!url) line('              El alta muestra "revisá tu email", que es el camino real, no un fallback.');

  // Does findScheduleByReference actually find what was just made? This is the recovery
  // path that prevents a double charge, tested end to end.
  const found = await recurring.findScheduleByReference({ config, request: ghl.ghlRequest, reference });
  line(`   4) findScheduleByReference lo reencuentra: ${found === scheduleId ? '✅ SÍ' : `❌ NO (devolvió "${found}")`}`);

  // ── Y ahora lo único que importa de verdad: el código que se despliega ──
  //
  // Todo lo de arriba son llamadas del sondeo. Esto ejecuta createAndSchedule, la
  // función que corre en producción, para que "el sondeo pasa" y "el alta funciona"
  // no puedan volver a ser dos cosas distintas.
  step('A bis · createAndSchedule() de punta a punta — el código real');
  const liveReference = `probe-lib-${Date.now().toString(36)}`;
  try {
    const billing = await recurring.createAndSchedule({
      config, request: ghl.ghlRequest,
      contact: { ...TEST_CONTACT, id: contact.id },
      packageId: PACKAGE_ID, sizeId: SIZE_ID, vehicleLabel: 'PROBE LIB — borrar',
      reference: liveReference, timeZone: 'America/New_York'
    });
    created.libScheduleId = billing.scheduleId;
    const check = await ghl.ghlRequest(config, `/invoices/schedule/${encodeURIComponent(billing.scheduleId)}?${new URLSearchParams({ altId: config.locationId, altType: 'location' })}`, { version: 'v3' });
    const finalStatus = statusOf(check);
    line(`   scheduleId: ${billing.scheduleId}`);
    line(`   importe mensual: $${billing.monthlyAmount} · liveMode: ${billing.liveMode}`);
    line(`   estado final: ${finalStatus}`);
    line('');
    line(finalStatus === 'active' || finalStatus === 'scheduled'
      ? '   ⇒ ✅ EL ALTA DE MEMBRESÍA FUNCIONA. La suscripción queda activa.'
      : `   ⇒ ❌ quedó en "${finalStatus}", no activa.`);
  } catch (error) {
    line(`   ❌ createAndSchedule FALLÓ: ${error.name} ${error.code || ''} ${error.statusCode || ''} ${error.upstreamHint || ''} ${error.diagnosticMessage || ''}`);
  }
}

async function probeOpportunityMerge(config) {
  step('B · ¿PUT /opportunities/{id} fusiona o REEMPLAZA los campos personalizados?');

  const pipelines = await ghl.ghlRequest(config, `/opportunities/pipelines?locationId=${encodeURIComponent(config.locationId)}`, { version: '2021-07-28' });
  const pipeline = (pipelines.pipelines || []).find(item => String(item.name || '').trim().toLowerCase() === 'memberships');
  const stage = pipeline && (pipeline.stages || [])[0];
  if (!stage) { line('   ❌ no encuentro el pipeline Memberships; salteo'); return; }

  const fieldsData = await ghl.ghlRequest(config, `/locations/${encodeURIComponent(config.locationId)}/customFields?model=opportunity`, { version: '2021-07-28' });
  const byName = new Map((fieldsData.customFields || []).map(field => [String(field.name || '').trim(), field.id]));
  const planField = byName.get('Membership Plan');
  const checkoutField = byName.get('Membership Checkout ID');
  const statusField = byName.get('Membership Status');
  if (!planField || !checkoutField || !statusField) { line('   ❌ faltan campos; salteo'); return; }

  const contact = await ghl.upsertContact(config, TEST_CONTACT);
  const opportunity = await ghl.ghlRequest(config, '/opportunities/', {
    method: 'POST', version: '2021-07-28',
    body: {
      pipelineId: pipeline.id, pipelineStageId: stage.id, locationId: config.locationId,
      contactId: contact.id, name: 'PROBE — borrar', status: 'open',
      customFields: [
        { id: planField, fieldValue: 'PROBE-PLAN' },
        { id: checkoutField, fieldValue: 'PROBE-CHECKOUT' }
      ]
    }
  });
  const opportunityId = String((opportunity.opportunity || opportunity).id || '');
  if (!opportunityId) { line('   ❌ no se pudo crear la oportunidad de prueba'); return; }
  created.opportunityId = opportunityId;
  line(`   oportunidad de prueba: ${opportunityId} (plan=PROBE-PLAN, checkout=PROBE-CHECKOUT)`);

  // Exactly what grantCycle and the enrollment do: write ONE field, mention no other.
  await ghl.updateOpportunityFields(config, opportunityId, [{ id: statusField, value: 'PROBE-STATUS' }]);
  line('   escribo SOLO "Membership Status"…');

  const after = await ghl.ghlRequest(config, `/opportunities/${encodeURIComponent(opportunityId)}`, { version: '2021-07-28' });
  const fields = ((after.opportunity || after).customFields || []);
  const read = id => {
    const found = fields.find(entry => entry.id === id);
    return found ? String(found.fieldValue ?? found.value ?? '') : '';
  };

  const planSurvived = read(planField) === 'PROBE-PLAN';
  const checkoutSurvived = read(checkoutField) === 'PROBE-CHECKOUT';
  const statusWritten = read(statusField) === 'PROBE-STATUS';

  line(`   → Membership Plan:        ${planSurvived ? '✅ sobrevivió' : '❌ SE PERDIÓ'}`);
  line(`   → Membership Checkout ID: ${checkoutSurvived ? '✅ sobrevivió' : '❌ SE PERDIÓ'}`);
  line(`   → Membership Status:      ${statusWritten ? '✅ se escribió' : '❌ no se escribió'}`);
  line('');
  line(planSurvived && checkoutSurvived
    ? '   ⇒ VEREDICTO: FUSIONA. La suposición de todo el código es correcta.'
    : '   ⇒ VEREDICTO: REEMPLAZA. Hay que reescribir cada PUT parcial del proyecto —\n' +
      '              grantCycle, el alta y el panel — para reenviar todos los campos.');
}

async function cleanup(config) {
  if (KEEP) { line('\n--keep: no borro nada.'); return; }
  step('Limpieza');
  // A schedule that was ACTIVATED cannot be deleted: it has generated an invoice, and
  // HighLevel answers 400 "Invoice schedule is already associated with invoice". The
  // reachable end state is `cancelled`, which is what actually matters — a cancelled
  // schedule bills nobody. Only a schedule still in `draft` can be removed outright.
  //
  // Both facts verified 5 ago 2026. `POST /invoices/schedule/{id}/cancel` answers 201,
  // and DELETE wants altId/altType in the QUERY (in the body it answers 422 claiming
  // they are empty).
  for (const [label, scheduleId] of [['sondeo', created.scheduleId], ['createAndSchedule', created.libScheduleId]]) {
    if (!scheduleId) continue;
    const query = new URLSearchParams({ altId: config.locationId, altType: 'location' });
    let cancelled = false;
    try {
      await ghl.ghlRequest(config, `/invoices/schedule/${encodeURIComponent(scheduleId)}/cancel`, {
        method: 'POST', version: recurring.INVOICE_VERSION,
        body: { altId: config.locationId, altType: 'location' }
      });
      cancelled = true;
    } catch (error) { /* a draft has nothing to cancel */ }

    try {
      await ghl.ghlRequest(config, `/invoices/schedule/${encodeURIComponent(scheduleId)}?${query}`, {
        method: 'DELETE', version: recurring.INVOICE_VERSION
      });
      line(`   ${label}: ${scheduleId} borrado`);
    } catch (error) {
      line(cancelled
        ? `   ${label}: ${scheduleId} CANCELADO (no se puede borrar: ya generó factura). No cobra a nadie.`
        : `   ⚠️  ${label}: no pude ni cancelar ni borrar ${scheduleId} — revisalo a mano`);
    }
  }
  if (created.opportunityId) {
    try {
      await ghl.ghlRequest(config, `/opportunities/${encodeURIComponent(created.opportunityId)}`, {
        method: 'DELETE', version: '2021-07-28'
      });
      line(`   oportunidad ${created.opportunityId} borrada`);
    } catch (error) {
      line(`   ⚠️  NO pude borrar la oportunidad ${created.opportunityId} (${error.statusCode || error.name}) — borrala a mano`);
    }
  }
  if (!created.scheduleId && !created.libScheduleId && !created.opportunityId) line('   nada que borrar');
}

async function main() {
  if (String(process.env.GHL_MEMBERSHIP_LIVE_MODE || '') === 'true') {
    console.error('GHL_MEMBERSHIP_LIVE_MODE=true — este sondeo NO corre en modo vivo. Abortado.');
    process.exitCode = 1;
    return;
  }

  // Built by hand rather than through ghl.getConfig(), which also demands the four van
  // calendars, the pipeline and the stage ids. None of that is touched here, and every
  // extra variable is another thing that has to be right before a probe can even start.
  const token = String(process.env.GHL_PRIVATE_TOKEN || '').trim();
  const locationId = String(process.env.GHL_LOCATION_ID || '').trim();
  if (!token || !locationId) {
    console.error('Faltan GHL_PRIVATE_TOKEN y/o GHL_LOCATION_ID en .env.probe.');
    process.exitCode = 1;
    return;
  }
  const config = {
    token,
    locationId,
    // Only used as `assignedTo` when upserting the test contact; blank is fine.
    assignedUserId: String(process.env.GHL_ASSIGNED_USER_ID || '').trim(),
    membershipPaymentsLiveMode: false
  };

  line(`Sondeo de ESCRITURA · modo test (liveMode:false) · location ${config.locationId.slice(0, 6)}…`);
  line(`Plan: ${PACKAGE_ID}/${SIZE_ID} · contacto "${TEST_CONTACT.name}"`);
  line('Crea: 1 factura recurrente + 1 oportunidad. Las borra al terminar.');

  if (!APPLY) {
    line('\nEsto es solo el plan. Para ejecutarlo:');
    line('   node --env-file=.env.probe scripts/probe-ghl-write.mjs --apply');
    return;
  }

  try {
    await probeRecurring(config);
    await probeOpportunityMerge(config);
  } finally {
    await cleanup(config);
  }
}

main().catch(error => {
  console.error('\nEl sondeo se cayó:', error.name, error.statusCode || '', error.upstreamHint || "", error.diagnosticMessage || "");
  console.error('Ids creados que pueden haber quedado:', JSON.stringify(created));
  process.exitCode = 1;
});
