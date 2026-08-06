'use strict';

// The crew panel, and above all the LIMITS of the link that opens it.
//
// A signed link that can mark money collected is a real capability, so most of what
// is asserted here is what the link CANNOT do: another van, another day, another
// action, a forged signature.

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupAgenda, callHandler, businessDate, CALENDARS } = require('./support/harness.js');

const crewHandler = require('../api/crew.js');
const crewLink = require('../api/_lib/crew-link.js');
const { moneyFromDescription, orderFromDescription, CASH_MAX } = crewHandler._test;

const SECRET = 'a-crew-secret-long-enough-to-be-real';

function setup(options = {}) {
  return setupAgenda({ ...options, env: { CREW_LINK_SECRET: SECRET, ...(options.env || {}) } });
}

// An appointment on a van's calendar, shaped the way the agenda writes them.
function stopOn(ctx, calendarId, { startHour = 9, endHour = 10, status = 'confirmed', title = 'RESERVA — 2024 Toyota Camry', dayOffset = 0, notes } = {}) {
  // In the BUSINESS timezone, not UTC: "today" for the endpoint is Naples' today.
  const iso = businessDate(dayOffset);
  const events = ctx.ghl.calendarEvents[calendarId] || (ctx.ghl.calendarEvents[calendarId] = []);
  events.push({
    id: `appt-${calendarId}-${events.length + 1}`,
    start: Date.parse(`${iso}T${String(startHour).padStart(2, '0')}:00:00-04:00`),
    end: Date.parse(`${iso}T${String(endHour).padStart(2, '0')}:00:00-04:00`),
    status,
    title,
    address: '1234 Palm Ave',
    contactId: 'contact-1',
    notes: notes === undefined ? 'Hold h1 · orden: 9:00 AM basico-exterior · total: $130 · deposito: $30' : notes
  });
  return events[events.length - 1].id;
}

// ── The link ───────────────────────────────────────────────────────────────

test('a link opens exactly one van, and nothing without a secret', t => {
  const ctx = setup();
  t.after(() => ctx.restore());

  const token = crewLink.sign('camioneta_2');
  assert.equal(crewLink.verify(token), 'camioneta_2');

  // A different van's token is a different string, and neither validates as the other.
  assert.notEqual(crewLink.sign('camioneta_1'), token);
  assert.throws(() => crewLink.verify('camioneta_1.' + token.split('.')[1]), /Invalid link/);

  // Tampering with the van, the signature, or the shape.
  assert.throws(() => crewLink.verify('camioneta_2.deadbeef'), /Invalid link/);
  assert.throws(() => crewLink.verify('camioneta_2'), /Invalid link/);
  assert.throws(() => crewLink.verify(''), /Invalid link/);
  // A key that is not a van key never reaches the HMAC.
  assert.throws(() => crewLink.verify('../../etc/passwd.x'), /Invalid link/);
});

test('a weak or missing secret refuses to sign rather than defaulting', t => {
  const ctx = setup({ env: { CREW_LINK_SECRET: 'short' } });
  t.after(() => ctx.restore());
  // A default signing key would mean every deployment of this code shares one, so a
  // token minted anywhere would open this account.
  assert.throws(() => crewLink.sign('camioneta_1'), /not configured/i);
});

// ── Reading the day ────────────────────────────────────────────────────────

test('the panel lists today for its own van, in order, with what to collect', async t => {
  const ctx = setup();
  t.after(() => ctx.restore());

  stopOn(ctx, CALENDARS[0], { startHour: 13, endHour: 14, title: 'RESERVA — F150' });
  stopOn(ctx, CALENDARS[0], { startHour: 9, endHour: 10, title: 'RESERVA — Camry' });
  // Another van's work, and a cancelled stop, must not appear.
  stopOn(ctx, CALENDARS[1], { startHour: 9, endHour: 10, title: 'OTRA CAMIONETA' });
  stopOn(ctx, CALENDARS[0], { startHour: 16, endHour: 17, status: 'cancelled', title: 'CANCELADA' });

  const res = await callHandler(crewHandler, null, {
    method: 'GET', query: { t: crewLink.sign('camioneta_1') }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.van, 'camioneta_1');
  assert.deepEqual(res.body.stops.map(stop => stop.title), ['RESERVA — Camry', 'RESERVA — F150']);
  assert.equal(res.body.stops[0].from, '9:00 AM');
  // The money the crew has to ask for, parsed out of what the booking wrote.
  assert.equal(res.body.stops[0].total, 130);
  assert.equal(res.body.stops[0].deposit, 30);
  assert.equal(res.body.stops[0].balance, 100);

  // No CRM identifiers reach the browser.
  assert.equal(JSON.stringify(res.body).includes('contact-1'), false);
  res.body.stops.forEach(stop => assert.equal(stop.contactId, undefined));
});

test('yesterday and tomorrow are invisible', async t => {
  const ctx = setup();
  t.after(() => ctx.restore());

  stopOn(ctx, CALENDARS[0], { dayOffset: -1, title: 'AYER' });
  stopOn(ctx, CALENDARS[0], { dayOffset: 1, title: 'MAÑANA' });
  stopOn(ctx, CALENDARS[0], { title: 'HOY' });

  const res = await callHandler(crewHandler, null, { method: 'GET', query: { t: crewLink.sign('camioneta_1') } });
  assert.deepEqual(res.body.stops.map(stop => stop.title), ['HOY']);
});

test('a stop with no money written on it still shows up', async t => {
  const ctx = setup();
  t.after(() => ctx.restore());

  // Booked by the office by hand, so no total in the description. The crew needs the
  // stop more than the number.
  stopOn(ctx, CALENDARS[0], { title: 'A MANO', notes: '' });
  const res = await callHandler(crewHandler, null, { method: 'GET', query: { t: crewLink.sign('camioneta_1') } });
  assert.equal(res.body.stops.length, 1);
  assert.equal(res.body.stops[0].total, null);
  assert.equal(res.body.stops[0].balance, null);
});

// ── Marking a wash delivered ───────────────────────────────────────────────

test('marking attended sets showed, which is what spends a membership credit', async t => {
  const ctx = setup();
  t.after(() => ctx.restore());

  const appointmentId = stopOn(ctx, CALENDARS[0]);
  const res = await callHandler(crewHandler, {
    t: crewLink.sign('camioneta_1'), action: 'attended', appointmentId
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'showed');
  const update = ctx.ghl.calls.find(call =>
    call.method === 'PUT' && call.path === `/calendars/events/appointments/${appointmentId}`
  );
  assert.equal(update.body.appointmentStatus, 'showed');
});

test('no-show and cancel are recorded as statuses, never as deletions', async t => {
  const ctx = setup();
  t.after(() => ctx.restore());

  const token = crewLink.sign('camioneta_1');
  const missed = stopOn(ctx, CALENDARS[0], { startHour: 9, endHour: 10 });
  const called = stopOn(ctx, CALENDARS[0], { startHour: 11, endHour: 12 });

  const noShow = await callHandler(crewHandler, { t: token, action: 'no_show', appointmentId: missed });
  assert.equal(noShow.statusCode, 200);
  assert.equal(noShow.body.status, 'noshow');

  const cancelled = await callHandler(crewHandler, { t: token, action: 'cancel', appointmentId: called });
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.body.status, 'cancelled');

  // The record survives both: the panel may never destroy history, and a DELETE here
  // would also take the appointment the credit formula counts.
  assert.equal(ctx.ghl.calls.filter(call => call.method === 'DELETE').length, 0);
  // Neither of them moved money.
  assert.equal(ctx.ghl.calls.filter(call => String(call.path).startsWith('/invoices')).length, 0);
});

test('a no-show spends the credit and a cancellation gives it back', () => {
  const membershipCrm = require('../api/_lib/membership-crm.js');
  // The van drove to the address and the slot is gone, so the cycle pays for it.
  assert.equal(membershipCrm.SPENDS_CREDIT.has('noshow'), true);
  assert.equal(membershipCrm.SPENDS_CREDIT.has('showed'), true);
  // Cancelling is free, and it must also stop counting as the contract's open visit —
  // otherwise a cancelled member could never book again.
  assert.equal(membershipCrm.SPENDS_CREDIT.has('cancelled'), false);
  assert.equal(membershipCrm.OPEN.has('cancelled'), false);
});

test('a payment link is sent for the amount asked, and marks nothing paid', async t => {
  const ctx = setup();
  t.after(() => ctx.restore());

  const appointmentId = stopOn(ctx, CALENDARS[0]);
  const res = await callHandler(crewHandler, {
    t: crewLink.sign('camioneta_1'), action: 'payment_link', appointmentId, amount: 100
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.method, 'link');
  assert.equal(res.body.amount, 100);
  assert.match(res.body.paymentUrl, /^https:\/\//);

  const sent = ctx.ghl.calls.find(call => call.method === 'POST' && call.path === '/invoices/text2pay');
  // `action: send` is what makes the link payable instead of a draft.
  assert.equal(sent.body.action, 'send');
  assert.equal(sent.body.items[0].amount, 100);

  // Unlike cash, nobody has the money yet, so nothing may be recorded as paid.
  assert.equal(ctx.ghl.calls.filter(call => /record-payment$/.test(String(call.path))).length, 0);
  // And the stop's status is untouched: paying is not the same as being served.
  assert.equal(ctx.ghl.calls.filter(call => call.method === 'PUT').length, 0);
});

test('every money action is capped, whichever way it collects', async t => {
  const ctx = setup();
  t.after(() => ctx.restore());

  const token = crewLink.sign('camioneta_1');
  const appointmentId = stopOn(ctx, CALENDARS[0]);

  for (const action of ['cash', 'payment_link']) {
    for (const amount of [0, -5, CASH_MAX + 1, 'mucho']) {
      const res = await callHandler(crewHandler, { t: token, action, appointmentId, amount });
      assert.equal(res.statusCode, 422, `${action} ${amount}`);
      assert.equal(res.body.code, 'CREW_AMOUNT_INVALID', `${action} ${amount}`);
    }
  }
  assert.equal(ctx.ghl.calls.filter(call => String(call.path).startsWith('/invoices')).length, 0);
});

test('a crew cannot touch another van, another day, or an invented stop', async t => {
  const ctx = setup();
  t.after(() => ctx.restore());

  const mine = stopOn(ctx, CALENDARS[0]);
  const other = stopOn(ctx, CALENDARS[1]);
  const yesterday = stopOn(ctx, CALENDARS[0], { dayOffset: -1 });
  const token = crewLink.sign('camioneta_1');

  for (const [label, appointmentId] of [['another van', other], ['yesterday', yesterday], ['invented', 'appt-nope']]) {
    const res = await callHandler(crewHandler, { t: token, action: 'attended', appointmentId });
    assert.equal(res.statusCode, 404, label);
    assert.equal(res.body.code, 'CREW_STOP_NOT_FOUND', label);
  }

  // And nothing was written for any of them.
  assert.equal(ctx.ghl.calls.filter(call => call.method === 'PUT').length, 0);

  // The crew's own stop still works, so the guard is not simply refusing everything.
  const ok = await callHandler(crewHandler, { t: token, action: 'attended', appointmentId: mine });
  assert.equal(ok.statusCode, 200);
});

test('an unsigned or forged token is refused before anything is read', async t => {
  const ctx = setup();
  t.after(() => ctx.restore());
  stopOn(ctx, CALENDARS[0]);

  for (const token of ['', 'camioneta_1.forged', 'camioneta_1', crewLink.sign('camioneta_1') + 'x']) {
    const res = await callHandler(crewHandler, null, { method: 'GET', query: { t: token } });
    assert.ok(res.statusCode === 403 || res.statusCode === 400, `token ${JSON.stringify(token)} → ${res.statusCode}`);
  }
  assert.equal(ctx.ghl.calls.filter(call => call.path.startsWith('/calendars/events?')).length, 0);
});

// ── Cash ───────────────────────────────────────────────────────────────────

test('cash is recorded as a paid invoice, with who took it', async t => {
  const ctx = setup();
  t.after(() => ctx.restore());

  const appointmentId = stopOn(ctx, CALENDARS[0]);
  const res = await callHandler(crewHandler, {
    t: crewLink.sign('camioneta_1'), action: 'cash', appointmentId, amount: 100, takenBy: 'Brenda'
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.amount, 100);
  assert.equal(res.body.method, 'cash');
  assert.ok(res.body.invoiceId);

  // An invoice was raised against the customer and immediately marked paid in cash, so
  // the collection lands in the CRM's reporting rather than in a note.
  const created = ctx.ghl.calls.find(call => call.method === 'POST' && call.path === '/invoices/');
  assert.equal(created.body.contactDetails.id, 'contact-1');
  assert.equal(created.body.items[0].amount, 100);

  const paid = ctx.ghl.calls.find(call => call.method === 'POST' && /record-payment$/.test(call.path));
  assert.equal(paid.body.mode, 'cash');
  assert.equal(paid.body.amount, 100);
  assert.match(paid.body.notes, /Brenda/);
  assert.match(paid.body.notes, new RegExp(appointmentId));
});

test('a slipped digit cannot record thousands, and a bad amount records nothing', async t => {
  const ctx = setup();
  t.after(() => ctx.restore());

  const appointmentId = stopOn(ctx, CALENDARS[0]);
  const token = crewLink.sign('camioneta_1');

  for (const amount of [0, -50, CASH_MAX + 1, 'mucho', null]) {
    const res = await callHandler(crewHandler, { t: token, action: 'cash', appointmentId, amount });
    assert.equal(res.statusCode, 422, `amount ${JSON.stringify(amount)}`);
    assert.equal(res.body.code, 'CREW_AMOUNT_INVALID');
  }
  assert.equal(ctx.ghl.calls.filter(call => call.path === '/invoices/').length, 0);
});

test('only the five known actions are accepted', async t => {
  const ctx = setup();
  t.after(() => ctx.restore());

  const appointmentId = stopOn(ctx, CALENDARS[0]);
  const token = crewLink.sign('camioneta_1');

  // `cancel` moved into the allowlist on purpose — an outcome the crew cannot record
  // is an outcome the office has to open the CRM for. Destroying and moving a booking
  // did not: deleting loses the history the credit formula reads, and rescheduling is
  // a conversation with the customer, not a button in a driveway.
  for (const action of ['delete', 'reschedule', 'refund', 'complete', 'showed']) {
    const res = await callHandler(crewHandler, { t: token, action, appointmentId });
    assert.equal(res.statusCode, 422, action);
    assert.equal(res.body.code, 'CREW_ACTION_INVALID', action);
  }
  // A blank action never even reaches the allowlist; it fails input validation first.
  const blank = await callHandler(crewHandler, { t: token, action: '', appointmentId });
  assert.equal(blank.statusCode, 400);
  assert.equal(ctx.ghl.calls.filter(call => call.method === 'PUT' || call.method === 'DELETE').length, 0);
});

// ── Parsing what the booking wrote ─────────────────────────────────────────

test('the money and running order survive the description round-trip', () => {
  const description = 'Hold abc · expira 2026-09-01T00:00:00.000Z · orden: 9:00 AM basico-exterior, 10:00 AM vip · total: From $1,250 · deposito: $50';
  assert.deepEqual(moneyFromDescription(description), { total: 1250, deposit: 50, balance: 1200 });
  // BOTH vehicles. The order is comma-separated because '·' separates the
  // description's own fields: written with '·' inside the value, as it was until
  // 2026-08-06, this parse stopped at the first vehicle and a crew arriving at a
  // two-car driveway was told about one car.
  assert.equal(orderFromDescription(description), '9:00 AM basico-exterior, 10:00 AM vip');

  // Nothing written, nothing invented.
  assert.deepEqual(moneyFromDescription(''), { total: null, deposit: null, balance: null });
  assert.deepEqual(moneyFromDescription('total: $40'), { total: 40, deposit: null, balance: null });
  // A deposit larger than the total never produces a negative balance to collect.
  assert.equal(moneyFromDescription('total: $30 · deposito: $50').balance, 0);
});
