#!/usr/bin/env node
// Does HighLevel refuse to double-book a van's calendar on its own?
//
// This is the one unverified fact the DB-free agenda depends on. Today the agenda
// passes `ignoreFreeSlotValidation: true` on every appointment (see ghl.js) because
// Postgres was the authority on who gets a van. If HighLevel's own validation can
// take that job over, the holds/assignments tables stop being load-bearing.
//
// Two things have to be true, and they are asked in order:
//
//   1. A van calendar accepts a LONG appointment (a 3-vehicle visit is 3h30) with
//      validation ON. This is the risk: HighLevel validates against the calendar's
//      configured slot shape, and these calendars were never configured for it —
//      which is exactly why the flag was turned on in the first place.
//   2. A SECOND appointment overlapping the first is REFUSED. If both are accepted,
//      HighLevel is not protecting anything and the DB-free plan does not work.
//
// Safety, in the same shape as api/internal/membership-recurring-test.js:
//   · a DND contact on a reserved `.test` address, so nothing can be delivered
//   · a date ~90 days out, past BOOKING_WINDOW_DAYS, so it cannot collide with
//     real work the crew has on its calendar
//   · toNotify: false, so no automation runs
//   · every appointment it creates is deleted again in a finally block, and the ids
//     are printed so they can be removed by hand if the cleanup itself fails
//   · read-only by default: it refuses to write without --apply
//
//   node scripts/probe-ghl-slot-validation.mjs            # show the plan, write nothing
//   node scripts/probe-ghl-slot-validation.mjs --apply    # run it for real

const BASE_URL = 'https://services.leadconnectorhq.com';
const APPLY = process.argv.includes('--apply');

const token = process.env.GHL_PRIVATE_TOKEN;
const locationId = process.env.GHL_LOCATION_ID;
// Probe the first van only. One calendar is enough to learn the answer, and it
// keeps the footprint on the real sub-account as small as possible.
const calendarId = process.env.GHL_CALENDAR_CAMIONETA_1;

if (!token || !locationId || !calendarId) {
  console.error('Set GHL_PRIVATE_TOKEN, GHL_LOCATION_ID and GHL_CALENDAR_CAMIONETA_1.');
  console.error('From the project root: vercel env pull .env.probe --environment production');
  process.exit(1);
}

async function ghl(path, { method = 'GET', body, version = '2021-04-15' } = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      Version: version,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  return { status: response.status, ok: response.ok, body: parsed };
}

// A weekday about 90 days out, in the location's zone. Past the 60-day booking
// window, so the website cannot have sold it and the crew has nothing there.
function probeDate() {
  const target = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  while (target.getUTCDay() === 0 || target.getUTCDay() === 6) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target.toISOString().slice(0, 10);
}

const DATE = probeDate();
// 09:00–12:30 local: three sedans back to back (60+60+60) plus the 30-minute buffer.
const VISIT_START = `${DATE}T09:00:00-04:00`;
const VISIT_END = `${DATE}T12:30:00-04:00`;
// Starts inside the first appointment, so it must be refused if validation works.
const OVERLAP_START = `${DATE}T10:00:00-04:00`;
const OVERLAP_END = `${DATE}T11:00:00-04:00`;

function appointment({ contactId, title, startTime, endTime, validate }) {
  return {
    calendarId,
    locationId,
    contactId,
    title,
    appointmentStatus: 'confirmed',
    startTime,
    endTime,
    // The two knobs under test. `ignoreDateRange` only waives the minimum-notice
    // and date-range rules, which is not what we are measuring, so it stays ON to
    // isolate the slot-conflict behaviour we care about.
    ignoreDateRange: true,
    ignoreFreeSlotValidation: !validate,
    toNotify: false
  };
}

console.log(`calendar   : ${calendarId}`);
console.log(`probe date : ${DATE}  (≈90 days out, weekday)`);
console.log(`visit      : 09:00 → 12:30  (3h30 — three sedans plus one buffer)`);
console.log(`overlap    : 10:00 → 11:00  (inside the visit; must be refused)`);
console.log(`mode       : ${APPLY ? 'APPLY — will create and then delete appointments' : 'dry run — nothing is written'}`);

if (!APPLY) {
  console.log('\nRe-run with --apply to actually probe.');
  process.exit(0);
}

const created = [];

try {
  // ── A DND contact that cannot be messaged ────────────────────────────────
  const reference = `slot-probe-${Math.random().toString(36).slice(2, 10)}`;
  const contact = await ghl('/contacts/upsert', {
    method: 'POST',
    body: {
      locationId,
      name: 'L&B Slot Validation Probe',
      firstName: 'L&B',
      lastName: 'Slot Probe',
      email: `${reference}@example.test`,
      phone: '+12025550198',
      source: 'L&B slot validation probe',
      tags: ['l-b-automated-test', reference],
      dnd: true,
      createNewIfDuplicateAllowed: false
    }
  });
  const contactId = contact.body?.contact?.id || contact.body?.id;
  if (!contactId) {
    console.error(`\nFAILED to create the test contact (HTTP ${contact.status})`);
    console.error(JSON.stringify(contact.body, null, 2).slice(0, 800));
    process.exit(1);
  }
  console.log(`\ncontact    : ${contactId} (DND, .test address)`);

  // ── Question 1: does a 3h30 appointment pass validation? ─────────────────
  console.log('\n── 1. long appointment, validation ON ──');
  const long = await ghl('/calendars/events/appointments', {
    method: 'POST',
    body: appointment({
      contactId, title: `${reference} — 3h30 visit`,
      startTime: VISIT_START, endTime: VISIT_END, validate: true
    })
  });
  const longId = long.body?.appointment?.id || long.body?.id;
  if (longId) created.push(longId);
  console.log(`HTTP ${long.status} — ${longId ? `accepted (${longId})` : 'REFUSED'}`);
  if (!longId) console.log(JSON.stringify(long.body, null, 2).slice(0, 700));

  // If the long appointment was refused, find out whether the length is the problem
  // or the calendar rejects this window outright, by retrying with validation off.
  if (!longId) {
    const forced = await ghl('/calendars/events/appointments', {
      method: 'POST',
      body: appointment({
        contactId, title: `${reference} — 3h30 forced`,
        startTime: VISIT_START, endTime: VISIT_END, validate: false
      })
    });
    const forcedId = forced.body?.appointment?.id || forced.body?.id;
    if (forcedId) created.push(forcedId);
    console.log(`   retry with validation OFF: HTTP ${forced.status} — ${forcedId ? 'accepted' : 'also refused'}`);
    console.log(forcedId
      ? '   ⇒ the calendar rejects the SHAPE, not the window. Needs calendar reconfiguration.'
      : '   ⇒ the calendar rejects this window entirely. Something else is wrong.');
  }

  // ── Question 2: is an overlapping appointment refused? ───────────────────
  console.log('\n── 2. overlapping appointment, validation ON ──');
  const clash = await ghl('/calendars/events/appointments', {
    method: 'POST',
    body: appointment({
      contactId, title: `${reference} — overlap`,
      startTime: OVERLAP_START, endTime: OVERLAP_END, validate: true
    })
  });
  const clashId = clash.body?.appointment?.id || clash.body?.id;
  if (clashId) created.push(clashId);
  console.log(`HTTP ${clash.status} — ${clashId ? `ACCEPTED (${clashId})` : 'refused'}`);
  if (!clashId) console.log(JSON.stringify(clash.body, null, 2).slice(0, 500));

  // ── Verdict ─────────────────────────────────────────────────────────────
  console.log('\n════ verdict ════');
  if (created.length && !clashId) {
    console.log('HighLevel refuses the double-booking on its own.');
    console.log('⇒ The DB-free agenda is viable: drop ignoreFreeSlotValidation and let the CRM be the authority.');
  } else if (clashId) {
    console.log('HighLevel accepted BOTH appointments on the same van at the same time.');
    console.log('⇒ It is not protecting the van. The DB-free plan needs a different guard.');
  } else {
    console.log('The long appointment never passed validation, so question 2 is inconclusive.');
    console.log('⇒ Reconfigure the van calendars for variable-length appointments, then re-run.');
  }
} finally {
  // Clean up whatever was created, and say so loudly if it could not be removed.
  for (const id of created) {
    const del = await ghl(`/calendars/events/${id}`, { method: 'DELETE' });
    console.log(del.ok ? `cleaned up ${id}` : `COULD NOT DELETE ${id} (HTTP ${del.status}) — remove it by hand`);
  }
  if (!created.length) console.log('\nnothing to clean up.');
}
