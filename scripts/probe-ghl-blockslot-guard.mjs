#!/usr/bin/env node
// Do BLOCK SLOTS take part in HighLevel's conflict validation?
//
// The sibling probes proved appointments are validated and serialized. But the
// agenda's 15-minute HOLD is not an appointment — it is a block slot, because a hold
// is taken before the customer is known and `POST /calendars/events/appointments`
// requires a contactId.
//
// BlockSlotCreateRequestDTO has no ignoreFreeSlotValidation flag and documents no
// conflict behaviour, which suggests block slots are unguarded. That would mean the
// hold — the exact moment two customers compete for the last van — is the one step
// HighLevel does NOT protect. Worth knowing before designing around it.
//
// Three questions:
//   1. Are two OVERLAPPING block slots both accepted? (is the hold itself guarded?)
//   2. Does an existing block slot make an overlapping APPOINTMENT fail validation?
//      (do block slots at least count as busy, so a confirmation cannot double-book?)
//   3. Does an existing appointment make an overlapping BLOCK SLOT fail?
//
// Same safety rules as the other probes: a date far out, everything deleted in a
// finally block, nothing written without --apply. No contact is needed for block
// slots; one is created only for the appointment in question 2.

const BASE_URL = 'https://services.leadconnectorhq.com';
const APPLY = process.argv.includes('--apply');

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

function probeDate(offsetDays) {
  const target = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  while (target.getUTCDay() === 0 || target.getUTCDay() === 6) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target.toISOString().slice(0, 10);
}

// A separate day per question, so one question cannot contaminate the next.
const DAY_A = probeDate(104);
const DAY_B = probeDate(111);
const DAY_C = probeDate(118);

const idOf = result => result.body?.id || result.body?.appointment?.id || result.body?.blockedSlot?.id || null;
const why = result => result.body?.message || result.body?.error || `HTTP ${result.status}`;

function blockSlot(date, startHour, endHour, title) {
  return {
    calendarId,
    locationId,
    title,
    startTime: `${date}T${String(startHour).padStart(2, '0')}:00:00-04:00`,
    endTime: `${date}T${String(endHour).padStart(2, '0')}:00:00-04:00`
  };
}

console.log(`calendar : ${calendarId}`);
console.log(`days     : ${DAY_A} (q1), ${DAY_B} (q2), ${DAY_C} (q3)`);
console.log(`mode     : ${APPLY ? 'APPLY' : 'dry run — nothing is written'}`);
if (!APPLY) {
  console.log('\nRe-run with --apply to actually probe.');
  process.exit(0);
}

const blocks = [];
const appointments = [];

try {
  // ── 1. two overlapping block slots ───────────────────────────────────────
  console.log('\n── 1. block slot, then an OVERLAPPING block slot ──');
  const firstBlock = await ghl('/calendars/events/block-slots', {
    method: 'POST', body: blockSlot(DAY_A, 9, 12, 'L&B probe — hold A')
  });
  const firstBlockId = idOf(firstBlock);
  if (firstBlockId) blocks.push(firstBlockId);
  console.log(`first  : HTTP ${firstBlock.status} — ${firstBlockId ? 'accepted' : `refused (${why(firstBlock)})`}`);

  const clashBlock = await ghl('/calendars/events/block-slots', {
    method: 'POST', body: blockSlot(DAY_A, 10, 11, 'L&B probe — hold B overlapping')
  });
  const clashBlockId = idOf(clashBlock);
  if (clashBlockId) blocks.push(clashBlockId);
  console.log(`second : HTTP ${clashBlock.status} — ${clashBlockId ? 'ACCEPTED — the hold is NOT guarded' : `refused (${why(clashBlock)})`}`);

  // ── 2. block slot, then an overlapping appointment ───────────────────────
  console.log('\n── 2. block slot, then an overlapping APPOINTMENT (validation ON) ──');
  const guardBlock = await ghl('/calendars/events/block-slots', {
    method: 'POST', body: blockSlot(DAY_B, 9, 12, 'L&B probe — blocking hold')
  });
  const guardBlockId = idOf(guardBlock);
  if (guardBlockId) blocks.push(guardBlockId);
  console.log(`block  : HTTP ${guardBlock.status} — ${guardBlockId ? 'accepted' : 'refused'}`);

  const reference = `blockguard-${Math.random().toString(36).slice(2, 10)}`;
  const contact = await ghl('/contacts/upsert', {
    method: 'POST',
    body: {
      locationId, name: 'L&B Block Guard Probe', firstName: 'L&B', lastName: 'Block Probe',
      email: `${reference}@example.test`, phone: '+12025550196',
      source: 'L&B block guard probe', tags: ['l-b-automated-test', reference],
      dnd: true, createNewIfDuplicateAllowed: false
    }
  });
  const contactId = contact.body?.contact?.id || contact.body?.id;

  const appt = await ghl('/calendars/events/appointments', {
    method: 'POST',
    body: {
      calendarId, locationId, contactId,
      title: `${reference} — appointment over a block`,
      appointmentStatus: 'confirmed',
      startTime: `${DAY_B}T10:00:00-04:00`,
      endTime: `${DAY_B}T11:00:00-04:00`,
      ignoreDateRange: true, ignoreFreeSlotValidation: false, toNotify: false
    }
  });
  const apptId = idOf(appt);
  if (apptId) appointments.push(apptId);
  console.log(`appt   : HTTP ${appt.status} — ${apptId ? 'ACCEPTED — blocks do not count as busy' : `refused (${why(appt)})`}`);

  // ── 3. appointment, then an overlapping block slot ───────────────────────
  console.log('\n── 3. appointment, then an OVERLAPPING block slot ──');
  const baseAppt = await ghl('/calendars/events/appointments', {
    method: 'POST',
    body: {
      calendarId, locationId, contactId,
      title: `${reference} — base appointment`,
      appointmentStatus: 'confirmed',
      startTime: `${DAY_C}T09:00:00-04:00`,
      endTime: `${DAY_C}T12:00:00-04:00`,
      ignoreDateRange: true, ignoreFreeSlotValidation: false, toNotify: false
    }
  });
  const baseApptId = idOf(baseAppt);
  if (baseApptId) appointments.push(baseApptId);
  console.log(`appt   : HTTP ${baseAppt.status} — ${baseApptId ? 'accepted' : 'refused'}`);

  const overBlock = await ghl('/calendars/events/block-slots', {
    method: 'POST', body: blockSlot(DAY_C, 10, 11, 'L&B probe — block over an appointment')
  });
  const overBlockId = idOf(overBlock);
  if (overBlockId) blocks.push(overBlockId);
  console.log(`block  : HTTP ${overBlock.status} — ${overBlockId ? 'accepted' : `refused (${why(overBlock)})`}`);

  // ── What it means for the design ─────────────────────────────────────────
  console.log('\n════ what this means ════');
  if (clashBlockId) {
    console.log('· The HOLD is not guarded: two block slots can claim the same van.');
    console.log('  ⇒ Holds cannot rely on HighLevel to arbitrate. Either make the hold an');
    console.log('    APPOINTMENT (needs a contact up front), or keep a guard for that step.');
  } else {
    console.log('· Block slots ARE guarded — the hold itself is safe.');
  }
  if (apptId) {
    console.log('· A block slot does NOT stop an overlapping appointment.');
    console.log('  ⇒ A held van can still be booked over. Holds must be appointments.');
  } else {
    console.log('· A block slot DOES stop an overlapping appointment: holds count as busy.');
  }
} finally {
  for (const id of appointments) {
    const del = await ghl(`/calendars/events/${id}`, { method: 'DELETE' });
    console.log(del.ok ? `cleaned up appointment ${id}` : `COULD NOT DELETE appointment ${id} (HTTP ${del.status})`);
  }
  for (const id of blocks) {
    const del = await ghl(`/calendars/events/${id}`, { method: 'DELETE' });
    console.log(del.ok ? `cleaned up block ${id}` : `COULD NOT DELETE block ${id} (HTTP ${del.status})`);
  }
}
