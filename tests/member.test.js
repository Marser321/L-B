'use strict';

// The member link: what it shows, what it lets a member do, and what it refuses.
//
// The most important assertions here are about the BALANCE, because it is derived from
// the calendar rather than stored. If counting is wrong a member gets a free wash or
// loses one they paid for, and no field anywhere would contradict it.

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupAgenda, callHandler, CALENDARS } = require('./support/harness.js');

const memberHandler = require('../api/member.js');
const membershipCrm = require('../api/_lib/membership-crm.js');
const signedLink = require('../api/_lib/signed-link.js');

const SECRET = 'a-member-secret-long-enough-to-be-real';
const CONTRACT = 'opp-membership-1';
const DAY = 24 * 60 * 60 * 1000;
const WEBHOOK_SECRET = 'a-webhook-secret-long-enough';
const WEBHOOK_AUTH = { headers: { authorization: `Bearer ${WEBHOOK_SECRET}` } };

function setup(options = {}) {
  memberHandler._test.resetFieldCache();
  return setupAgenda({ ...options, env: { MEMBER_LINK_SECRET: SECRET, ...(options.env || {}) } });
}

function token(contractId = CONTRACT) {
  return signedLink.sign('member', contractId);
}

// A wash on a van's calendar, tagged with the contract the way bookVisit writes it.
function washOn(ctx, calendarId, { dayOffset, status = 'showed', contractId = CONTRACT, hour = 9, tagged = true } = {}) {
  const iso = new Date(Date.now() + dayOffset * DAY).toISOString().slice(0, 10);
  const events = ctx.ghl.calendarEvents[calendarId] || (ctx.ghl.calendarEvents[calendarId] = []);
  events.push({
    id: `appt-${calendarId}-${events.length + 1}`,
    start: Date.parse(`${iso}T${String(hour).padStart(2, '0')}:00:00-04:00`),
    end: Date.parse(`${iso}T${String(hour + 1).padStart(2, '0')}:30:00-04:00`),
    status,
    title: 'MEMBRESIA — 2024 Toyota Camry',
    contactId: 'contact-1',
    notes: tagged ? `${membershipCrm.contractTag(contractId)} · plan membresia-2x` : 'lavado suelto'
  });
  return events[events.length - 1].id;
}

async function status(ctx, { date, contractId } = {}) {
  const query = { t: token(contractId) };
  if (date) query.date = date;
  return callHandler(memberHandler, null, { method: 'GET', query });
}

// A weekday at least 48 hours out, inside the cycle.
function bookableDate(offsetDays = 5) {
  const target = new Date(Date.now() + offsetDays * DAY);
  while (target.getUTCDay() === 0) target.setUTCDate(target.getUTCDate() + 1);
  return target.toISOString().slice(0, 10);
}

// ── What the page shows ────────────────────────────────────────────────────

test('the page shows the plan, the vehicle and what is left', async t => {
  const ctx = setup();
  t.after(() => ctx.restore());

  const res = await status(ctx);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.plan, 'membresia-2x');
  assert.equal(res.body.vehicle, '2024 Toyota Camry');
  assert.equal(res.body.creditsPerCycle, 2);
  assert.equal(res.body.remaining, 2, 'nothing delivered yet');
  assert.equal(res.body.canBook, true);
  assert.equal(res.body.noticeHours, 48);

  // Nothing about the customer beyond what the member already knows about themselves.
  const serialized = JSON.stringify(res.body);
  for (const leak of ['contact-1', '@', 'phone', 'Palm Ave']) {
    assert.equal(serialized.includes(leak), false, `must not expose ${leak}`);
  }
});

// ── The balance, which is counted rather than stored ───────────────────────

test('a delivered wash is counted, and only for this contract', async t => {
  const ctx = setup();
  t.after(() => ctx.restore());

  washOn(ctx, CALENDARS[0], { dayOffset: -3, status: 'showed' });
  // Another member's wash, and an untagged one-off job, must not count against this
  // member's balance.
  washOn(ctx, CALENDARS[1], { dayOffset: -2, status: 'showed', contractId: 'opp-someone-else' });
  washOn(ctx, CALENDARS[2], { dayOffset: -2, status: 'showed', tagged: false });

  const res = await status(ctx);
  assert.equal(res.body.used, 1);
  assert.equal(res.body.remaining, 1);
});

test('a wash that was booked but not delivered still costs a credit', async t => {
  const ctx = setup();
  t.after(() => ctx.restore());

  washOn(ctx, CALENDARS[0], { dayOffset: 4, status: 'confirmed' });

  const res = await status(ctx);
  // Not delivered, so not "used" — but committed, so not available either. Otherwise a
  // member could book, see a spare credit, and book again.
  assert.equal(res.body.used, 0);
  assert.equal(res.body.remaining, 1);
  assert.ok(res.body.nextVisit, 'the page shows what is already booked');
  assert.equal(res.body.canBook, false);
  assert.equal(res.body.reason, 'visit_already_booked');
});

test('a cancelled wash costs nothing', async t => {
  const ctx = setup();
  t.after(() => ctx.restore());

  washOn(ctx, CALENDARS[0], { dayOffset: 4, status: 'cancelled' });
  const res = await status(ctx);
  assert.equal(res.body.remaining, 2);
  assert.equal(res.body.canBook, true);
});

test('two delivered washes exhaust a 2x cycle', async t => {
  const ctx = setup();
  t.after(() => ctx.restore());

  washOn(ctx, CALENDARS[0], { dayOffset: -6, status: 'showed' });
  washOn(ctx, CALENDARS[1], { dayOffset: -2, status: 'completed' });

  const res = await status(ctx);
  assert.equal(res.body.used, 2);
  assert.equal(res.body.remaining, 0);
  assert.equal(res.body.canBook, false);
  assert.equal(res.body.reason, 'no_credits');
});

// ── Booking ────────────────────────────────────────────────────────────────

test('booking a wash takes one van, confirms it, and tags it for counting', async t => {
  const ctx = setup();
  t.after(() => ctx.restore());

  const date = bookableDate();
  const res = await callHandler(memberHandler, { t: token(), date, startTime: '09:00' });

  assert.equal(res.statusCode, 201);
  assert.ok(CALENDARS.some(id => id));
  assert.equal(res.body.remaining, 1, 'one credit committed');

  const created = ctx.ghl.created.filter(entry => entry.kind === 'appointment');
  assert.equal(created.length, 1, 'one appointment, on one van');
  // Tagged, or the credit could never be counted.
  assert.ok(created[0].body.description.includes(membershipCrm.contractTag(CONTRACT)));
  // Nothing to pay, so it is confirmed rather than held pending payment.
  const confirm = ctx.ghl.calls.find(call =>
    call.method === 'PUT' && call.path.startsWith('/calendars/events/appointments/')
  );
  assert.equal(confirm.body.appointmentStatus, 'confirmed');
  // HighLevel validated the slot, which is what replaces a database lock. Read from the
  // POST itself: the confirming PUT sends ignoreFreeSlotValidation: true (the slot is
  // already ours by then) and the fake merges it into the stored record.
  const createCall = ctx.ghl.calls.find(call =>
    call.method === 'POST' && call.path === '/calendars/events/appointments'
  );
  assert.equal(createCall.body.ignoreFreeSlotValidation, false);
  assert.equal(createCall.body.appointmentStatus, 'new');
  // No money involved.
  assert.equal(ctx.ghl.calls.some(call => call.path.startsWith('/invoices')), false);
});

test('a busy van is skipped and the next one takes the visit', async t => {
  const ctx = setup();
  t.after(() => ctx.restore());

  const date = bookableDate();
  // Block every van but one, for the whole day.
  const dayStart = Date.parse(`${date}T08:00:00-04:00`);
  const dayEnd = Date.parse(`${date}T18:00:00-04:00`);
  for (const calendarId of CALENDARS.slice(0, 3)) {
    ctx.ghl.calendarEvents[calendarId] = [{ id: `busy-${calendarId}`, start: dayStart, end: dayEnd, status: 'confirmed' }];
  }

  const res = await callHandler(memberHandler, { t: token(), date, startTime: '09:00' });
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.resourceKey, 'camioneta_4', 'the only free van');
});

test('a full fleet answers 409 rather than double-booking', async t => {
  const ctx = setup();
  t.after(() => ctx.restore());

  const date = bookableDate();
  const dayStart = Date.parse(`${date}T08:00:00-04:00`);
  const dayEnd = Date.parse(`${date}T18:00:00-04:00`);
  for (const calendarId of CALENDARS) {
    ctx.ghl.calendarEvents[calendarId] = [{ id: `busy-${calendarId}`, start: dayStart, end: dayEnd, status: 'confirmed' }];
  }

  const res = await callHandler(memberHandler, { t: token(), date, startTime: '09:00' });
  assert.equal(res.statusCode, 409);
  assert.equal(ctx.ghl.created.filter(entry => entry.kind === 'appointment').length, 0);
});

test('the 48-hour rule and the end of the cycle are enforced on the server', async t => {
  const ctx = setup();
  t.after(() => ctx.restore());

  const tomorrow = new Date(Date.now() + DAY);
  while (tomorrow.getUTCDay() === 0) tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tooSoon = await callHandler(memberHandler, {
    t: token(), date: tomorrow.toISOString().slice(0, 10), startTime: '09:00'
  });
  assert.equal(tooSoon.statusCode, 409);
  assert.equal(tooSoon.body.code, 'MEMBERSHIP_TOO_SOON');

  // Past the paid cycle. The harness contract ends 20 days out.
  const afterCycle = await callHandler(memberHandler, { t: token(), date: bookableDate(40), startTime: '09:00' });
  assert.equal(afterCycle.statusCode, 409);
  assert.equal(afterCycle.body.code, 'MEMBERSHIP_AFTER_CYCLE_END');

  assert.equal(ctx.ghl.created.filter(entry => entry.kind === 'appointment').length, 0);
});

test('an exhausted balance cannot be spent, even by posting straight to the endpoint', async t => {
  const ctx = setup();
  t.after(() => ctx.restore());

  washOn(ctx, CALENDARS[0], { dayOffset: -6, status: 'showed' });
  washOn(ctx, CALENDARS[1], { dayOffset: -2, status: 'showed' });

  const res = await callHandler(memberHandler, { t: token(), date: bookableDate(), startTime: '09:00' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'MEMBERSHIP_NO_CREDITS');
  assert.equal(ctx.ghl.created.filter(entry => entry.kind === 'appointment').length, 0);
});

// ── The link ───────────────────────────────────────────────────────────────

test('a forged link, or one for another audience, opens nothing', async t => {
  const ctx = setup({ env: { CREW_LINK_SECRET: 'a-crew-secret-long-enough-to-be-real' } });
  t.after(() => ctx.restore());

  const crewToken = signedLink.sign('crew', 'camioneta_1');
  for (const bad of ['', `${CONTRACT}.forged`, CONTRACT, `${token()}x`, crewToken]) {
    const res = await callHandler(memberHandler, null, { method: 'GET', query: { t: bad } });
    assert.ok(res.statusCode === 403 || res.statusCode === 400, `${JSON.stringify(bad)} → ${res.statusCode}`);
  }
  // A crew link signed for a van is not a member link, even though the scheme is shared.
  assert.throws(() => signedLink.verify('member', crewToken), /Invalid link/);
});

test('a link to an opportunity that is not a membership opens nothing', async t => {
  const ctx = setup();
  t.after(() => ctx.restore());

  const res = await status(ctx, { contractId: 'opp-not-a-membership' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, 'MEMBERSHIP_NOT_FOUND');
});

test('a link to a contract that no longer exists says so, rather than looking like an outage', async t => {
  const ctx = setup({ contracts: { 'opp-membership-gone': null } });
  t.after(() => ctx.restore());

  const res = await status(ctx, { contractId: 'opp-membership-gone' });
  // Not a 502: the member would read "temporarily unavailable" and retry a link that
  // will never work again.
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, 'MEMBERSHIP_NOT_FOUND');
});

test('a weak secret refuses to sign rather than defaulting', t => {
  const ctx = setup({ env: { MEMBER_LINK_SECRET: 'short' } });
  t.after(() => ctx.restore());
  assert.throws(() => signedLink.sign('member', CONTRACT), /not configured/i);
});

// ── Slots ──────────────────────────────────────────────────────────────────

test('only times with a free van are offered, and only inside the rules', async t => {
  const ctx = setup();
  t.after(() => ctx.restore());

  const date = bookableDate();
  const res = await status(ctx, { date });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.slots.length > 0);
  // A 90-minute visit cannot start at 5pm and finish before 6pm.
  assert.equal(res.body.slots.includes('17:00'), false);
  assert.equal(res.body.slots[0], '08:00');

  // Fill the fleet for that morning and the early slots disappear.
  for (const calendarId of CALENDARS) {
    ctx.ghl.calendarEvents[calendarId] = [{
      id: `busy-${calendarId}`,
      start: Date.parse(`${date}T08:00:00-04:00`),
      end: Date.parse(`${date}T12:00:00-04:00`),
      status: 'confirmed'
    }];
  }
  const later = await status(ctx, { date });
  assert.equal(later.body.slots.includes('08:00'), false);
  assert.ok(later.body.slots.includes('12:00'));
});

// ── Granting a cycle (the webhook the GHL workflow calls) ──────────────────

test('a paid membership invoice activates the contract and moves the cycle', async t => {
  const ctx = setup({ env: { PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET } });
  t.after(() => ctx.restore());

  const webhookHandler = require('../api/payments/webhook.js');
  const res = await callHandler(webhookHandler, {
    type: 'InvoicePaid',
    id: 'inv-cycle-1',
    contractId: CONTRACT,
    // The invoice's own date, which is what makes this idempotent.
    cycleStartsAt: '2026-08-04T12:00:00.000Z'
  }, WEBHOOK_AUTH);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'active');
  // One month on, which is the ONLY thing that resets the balance: credits are counted
  // inside the cycle window, so moving the window forward is the reset.
  assert.equal(res.body.cycleEndsAt.slice(0, 10), '2026-09-04');

  const update = ctx.ghl.calls.find(call => call.method === 'PUT' && call.path === `/opportunities/${CONTRACT}`);
  const written = new Map(update.body.customFields.map(field => [field.id, field.field_value]));
  assert.equal(written.get('field-mem-status'), 'active');
  assert.equal(written.get('field-mem-cycle').slice(0, 10), '2026-09-04');
});

test('the same invoice delivered twice does not push the cycle out two months', async t => {
  const ctx = setup({ env: { PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET } });
  t.after(() => ctx.restore());

  const webhookHandler = require('../api/payments/webhook.js');
  const event = { type: 'InvoicePaid', id: 'inv-cycle-1', contractId: CONTRACT, cycleStartsAt: '2026-08-04T12:00:00.000Z' };

  const first = await callHandler(webhookHandler, event, WEBHOOK_AUTH);
  const second = await callHandler(webhookHandler, event, WEBHOOK_AUTH);

  // Idempotent by construction: the cycle end is computed FROM THE INVOICE, not from
  // now, so a redelivery writes the same value rather than granting another month.
  assert.equal(first.body.cycleEndsAt, second.body.cycleEndsAt);
});

// NOTE: HighLevel emits no "invoice payment failed" webhook — its invoice events are
// Create/Sent/Paid/PartiallyPaid/Void/Update/Delete. So past_due arrives by the office
// dragging the card to the Past Due stage, which the status reader already honours (see
// the past_due test below). What IS webhook-driven is a VOIDED invoice.
test('a voided invoice marks past_due and never touches the cycle', async t => {
  const ctx = setup({ env: { PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET } });
  t.after(() => ctx.restore());

  const webhookHandler = require('../api/payments/webhook.js');
  const res = await callHandler(webhookHandler, {
    type: 'InvoiceVoid', id: 'inv-void-1', contractId: CONTRACT
  }, WEBHOOK_AUTH);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'past_due');
  const update = ctx.ghl.calls.find(call => call.method === 'PUT' && call.path === `/opportunities/${CONTRACT}`);
  const written = new Map(update.body.customFields.map(field => [field.id, field.field_value]));
  assert.equal(written.get('field-mem-status'), 'past_due');
  // The cycle the customer DID pay for is untouched, so the wash they already booked
  // inside it survives.
  assert.equal(written.has('field-mem-cycle'), false);
});

test('a past_due contract cannot book, and the member is told why', async t => {
  const ctx = setup({
    contracts: {
      'opp-membership-late': {
        contact: { id: 'contact-1' },
        // The office dragged the card to Past Due. That IS the state change — there is no
        // webhook for a failed invoice payment, and no field to keep in sync.
        pipelineStageId: 'stage-mem-past',
        customFields: [
          { id: 'field-mem-plan', fieldValue: 'membresia-2x' },
          { id: 'field-mem-vehicle', fieldValue: '2024 Toyota Camry' },
          { id: 'field-mem-cycle', fieldValue: new Date(Date.now() + 20 * DAY).toISOString() }
        ]
      }
    }
  });
  t.after(() => ctx.restore());

  const shown = await status(ctx, { contractId: 'opp-membership-late' });
  assert.equal(shown.body.canBook, false);
  assert.equal(shown.body.reason, 'past_due');

  const attempt = await callHandler(memberHandler, {
    t: token('opp-membership-late'), date: bookableDate(), startTime: '09:00'
  });
  assert.equal(attempt.statusCode, 409);
  assert.equal(attempt.body.code, 'MEMBERSHIP_PAST_DUE');
  assert.equal(ctx.ghl.created.filter(entry => entry.kind === 'appointment').length, 0);
});
