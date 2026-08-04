#!/usr/bin/env node
// Is HighLevel's slot validation ATOMIC, or just a check with a race window?
//
// probe-ghl-slot-validation.mjs proved HighLevel refuses a SEQUENTIAL
// double-booking: create one appointment, then an overlapping one, and the second
// gets 400 "The slot you have selected is no longer available."
//
// That is not the same question as this one. A check-then-write done inside their
// API still has a window: if four requests arrive in the same instant, they may all
// read "free" before any of them writes. Postgres closes that window with an
// exclusion constraint; the DB-free agenda needs to know whether HighLevel does.
//
// So: fire N identical requests for the same slot CONCURRENTLY and count the
// winners. Exactly one 201 means the validation serializes and the van is safe.
// More than one means the window is real, and the agenda needs its own guard for
// the last few milliseconds.
//
// Same safety rules as the sibling probe: DND contact on a reserved .test address,
// a date ~90 days out, toNotify off, every appointment deleted in a finally block,
// and nothing written without --apply.
//
//   node scripts/probe-ghl-slot-race.mjs            # show the plan
//   node scripts/probe-ghl-slot-race.mjs --apply    # run it

const BASE_URL = 'https://services.leadconnectorhq.com';
const APPLY = process.argv.includes('--apply');
const RACERS = 4;

const token = process.env.GHL_PRIVATE_TOKEN;
const locationId = process.env.GHL_LOCATION_ID;
const calendarId = process.env.GHL_CALENDAR_CAMIONETA_1;

if (!token || !locationId || !calendarId) {
  console.error('Set GHL_PRIVATE_TOKEN, GHL_LOCATION_ID and GHL_CALENDAR_CAMIONETA_1.');
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

function probeDate() {
  // A different day from the sequential probe, so a leftover artifact from that run
  // cannot make this one look like a refusal.
  const target = new Date(Date.now() + 97 * 24 * 60 * 60 * 1000);
  while (target.getUTCDay() === 0 || target.getUTCDay() === 6) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target.toISOString().slice(0, 10);
}

const DATE = probeDate();
const START = `${DATE}T09:00:00-04:00`;
const END = `${DATE}T12:30:00-04:00`;

console.log(`calendar   : ${calendarId}`);
console.log(`probe date : ${DATE}`);
console.log(`slot       : 09:00 → 12:30`);
console.log(`racers     : ${RACERS} identical requests fired at once, validation ON`);
console.log(`mode       : ${APPLY ? 'APPLY' : 'dry run — nothing is written'}`);

if (!APPLY) {
  console.log('\nRe-run with --apply to actually probe.');
  process.exit(0);
}

const created = [];

try {
  const reference = `race-probe-${Math.random().toString(36).slice(2, 10)}`;
  const contact = await ghl('/contacts/upsert', {
    method: 'POST',
    body: {
      locationId,
      name: 'L&B Slot Race Probe',
      firstName: 'L&B',
      lastName: 'Race Probe',
      email: `${reference}@example.test`,
      phone: '+12025550197',
      source: 'L&B slot race probe',
      tags: ['l-b-automated-test', reference],
      dnd: true,
      createNewIfDuplicateAllowed: false
    }
  });
  const contactId = contact.body?.contact?.id || contact.body?.id;
  if (!contactId) {
    console.error(`\nFAILED to create the test contact (HTTP ${contact.status})`);
    process.exit(1);
  }
  console.log(`\ncontact    : ${contactId} (DND, .test address)`);

  // All N at once. No await between them, so they are in flight together.
  const results = await Promise.all(
    Array.from({ length: RACERS }, (unused, index) =>
      ghl('/calendars/events/appointments', {
        method: 'POST',
        body: {
          calendarId,
          locationId,
          contactId,
          title: `${reference} — racer ${index + 1}`,
          appointmentStatus: 'confirmed',
          startTime: START,
          endTime: END,
          ignoreDateRange: true,
          ignoreFreeSlotValidation: false,
          toNotify: false
        }
      })
    )
  );

  console.log('\n── results ──');
  results.forEach((result, index) => {
    const id = result.body?.appointment?.id || result.body?.id;
    if (id) created.push(id);
    const detail = id ? `WON (${id})` : `refused — ${result.body?.message || result.body?.error || ''}`;
    console.log(`racer ${index + 1}: HTTP ${result.status} — ${detail}`);
  });

  const winners = created.length;
  console.log('\n════ verdict ════');
  if (winners === 1) {
    console.log(`Exactly 1 of ${RACERS} concurrent requests won the slot.`);
    console.log('⇒ HighLevel SERIALIZES the check. The van is safe without Postgres.');
  } else if (winners === 0) {
    console.log('Every request was refused — inconclusive, something else blocked the slot.');
    console.log('⇒ Check the calendar is free on that date and re-run.');
  } else {
    console.log(`${winners} of ${RACERS} concurrent requests were ALL granted the same slot.`);
    console.log('⇒ The race window is real. A DB-free agenda needs its own guard here:');
    console.log('   read back the calendar after writing and cancel the loser, or keep a');
    console.log('   small lock outside HighLevel for the moment of allocation.');
  }
} finally {
  for (const id of created) {
    const del = await ghl(`/calendars/events/${id}`, { method: 'DELETE' });
    console.log(del.ok ? `cleaned up ${id}` : `COULD NOT DELETE ${id} (HTTP ${del.status}) — remove it by hand`);
  }
  if (!created.length) console.log('\nnothing to clean up.');
}
