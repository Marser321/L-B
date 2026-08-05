'use strict';

// The crew's panel: today's stops for ONE van, and the two buttons that close the
// loop on them.
//
// This is the piece that makes derived membership credits work at all. A credit is
// spent when the wash is DELIVERED, and the only person who knows that happened is
// the one who did it — so somebody has to mark the appointment `showed`, and that
// somebody is the crew. Without this endpoint no credit is ever consumed.
//
// It reads the van's CALENDAR, never the database. That is deliberate: the agenda is
// being moved off Postgres (DISENO-SIN-BASE-DE-DATOS.md), so anything built now that
// reads the calendar keeps working after the tables go.
//
// Authorisation is a signed link, not a session — see api/_lib/crew-link.js. The
// capability that link grants is bounded HERE rather than in the token:
//
//   · TODAY only. Yesterday cannot be edited, tomorrow cannot be previewed.
//   · THAT van only. The token names one van and the calendar is looked up from it,
//     never from the request.
//   · A closed list of actions. Nothing is ever DELETED: `cancel` and `no_show` move
//     the appointment's status, so the record and its history survive either way.
//   · Nothing is rescheduled. Moving a visit is a conversation, not a button.
//   · No customer contact details in the response beyond the name and the address
//     the crew has to drive to. No phone, no email, no payment identifiers.
//
// The panel started with two actions and grew to five for one reason: every outcome it
// cannot record is an outcome the office has to open HighLevel for. A crew that can
// mark a wash delivered but not a customer who never opened the gate has just moved the
// work, not removed it.

const { RequestError, HighLevelError } = require('./_lib/errors.js');
const { sendJson, readBody, assertMethod } = require('./_lib/http.js');
const { text, optionalText } = require('./_lib/validate.js');
const ghl = require('./_lib/ghl.js');
const time = require('./_lib/time.js');
const crewLink = require('./_lib/crew-link.js');

// What the crew may do. Anything else is a 422, so a new capability has to be added
// here on purpose rather than by passing a different string.
//
//   attended     the wash happened          → spends a membership credit
//   no_show      nobody was there           → spends the credit too: the van drove out
//                                             and the slot is gone
//   cancel       called off in time         → free, and the credit goes back
//   cash         money taken at the door    → invoice created and recorded paid
//   payment_link the customer wants to pay by card → payable invoice, sent to them
const ACTIONS = Object.freeze(['attended', 'no_show', 'cancel', 'cash', 'payment_link']);

// The HighLevel appointment status each status-only action sets. Keeping them in one
// table is what makes it impossible to add an action that quietly writes a status the
// credit formula does not know about.
const STATUS_ACTIONS = Object.freeze({
  attended: 'showed',
  no_show: 'noshow',
  cancel: 'cancelled'
});

const CASH_MAX = 5000;

function statusCodeFor(error, fallback) {
  return error instanceof RequestError || error instanceof HighLevelError ? error.statusCode : fallback;
}

function publicError(error, fallbackCode) {
  return {
    ok: false,
    error: error instanceof RequestError ? error.message : 'Crew panel temporarily unavailable',
    code: error.code || fallbackCode
  };
}

// The van named by the token, resolved to its calendar through the server's own
// config. A request cannot name a calendar.
function resolveVan(token, config) {
  const resourceKey = crewLink.verify(token);
  const resource = config.resources.find(entry => entry.key === resourceKey);
  if (!resource) throw new RequestError('That van is not configured', 403, 'CREW_LINK_INVALID');
  return resource;
}

function tokenFrom(req, body) {
  const fromQuery = req.query && (req.query.t || req.query.token);
  return text(fromQuery || (body && body.t), 't', 8, 200);
}

// Today, in the location's timezone — never the crew phone's timezone, which may be
// wrong or simply set to somewhere else.
function todayBounds() {
  const timezone = time.bookingTimezone();
  const today = time.todayInZone(Date.now(), timezone);
  return {
    timezone,
    today,
    fromMs: time.zonedDateTimeToMs(today, '00:00', timezone),
    toMs: time.zonedDateTimeToMs(time.addDays(today, 1), '00:00', timezone)
  };
}

// `total: $130 · deposito: $30` was written into the appointment when the hold was
// taken, so the crew can be told what to collect without a database lookup. Parsed
// leniently: a missing or malformed value shows as null rather than failing the whole
// screen, because a crew standing in a driveway needs the list more than the number.
function moneyFromDescription(description) {
  const source = String(description || '');
  // Anchored to a field boundary, not just the word: the description is a `·`-separated
  // list of `key: value` pairs, and an unanchored `total:` also matches the tail of any
  // other key that happens to end in it. Getting that wrong here means telling the crew
  // to collect a number that is not the balance.
  const total = source.match(/(?:^|[\s·])total:\s*(?:from|desde)?\s*\$?([\d,]+)/i);
  const deposit = source.match(/(?:^|[\s·])deposito:\s*\$?([\d,]+)/i);
  const toNumber = match => (match ? Number(match[1].replace(/,/g, '')) : null);
  const totalAmount = toNumber(total);
  const depositAmount = toNumber(deposit);
  return {
    total: totalAmount,
    deposit: depositAmount,
    // What is still owed on site, when both numbers are known.
    balance: totalAmount == null || depositAmount == null ? null : Math.max(0, totalAmount - depositAmount)
  };
}

function orderFromDescription(description) {
  const match = String(description || '').match(/orden:\s*([^·]+)/i);
  return match ? match[1].trim() : '';
}

// One stop as the crew needs to see it. Everything else the calendar knows is
// deliberately dropped.
function presentStop(event, timezone) {
  const startMs = Date.parse(event.startTime);
  const endMs = Date.parse(event.endTime);
  const clock = ms => new Date(ms).toLocaleTimeString('en-US', {
    timeZone: timezone, hour: 'numeric', minute: '2-digit'
  });
  const money = moneyFromDescription(event.notes || event.description);
  return {
    appointmentId: event.id,
    // Needed to raise the cash invoice against the right customer. Stripped before
    // the list ever reaches the browser — see listToday.
    contactId: String(event.contactId || ''),
    status: String(event.appointmentStatus || 'confirmed'),
    startsAt: new Date(startMs).toISOString(),
    from: clock(startMs),
    to: clock(endMs),
    // The title already reads "Camry + RAV4" or the customer's name, written when the
    // booking was made.
    title: String(event.title || 'Reserva'),
    address: String(event.address || ''),
    order: orderFromDescription(event.notes || event.description),
    ...money
  };
}

async function listToday(config, resource) {
  const { timezone, today, fromMs, toMs } = todayBounds();
  const events = await ghl.calendarEventsForCalendar(config, resource.calendarId, fromMs, toMs);
  const stops = events
    .filter(event => String(event.appointmentStatus || '') !== 'cancelled')
    .map(event => presentStop(event, timezone))
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  return { ok: true, van: resource.key, date: today, timezone, stops };
}

// The same list with the CRM identifiers removed. Everything the browser sees goes
// through here, so adding a field to presentStop cannot leak one by accident.
function publicStops(stops) {
  return stops.map(({ contactId, ...rest }) => rest);
}

// The appointment must be one of TODAY'S on THIS van. Checked by listing the day and
// looking for the id, rather than by trusting the id — otherwise the token would let
// a crew member edit any appointment in the account.
async function assertTodaysStop(config, resource, appointmentId) {
  const { stops } = await listToday(config, resource);
  const stop = stops.find(entry => entry.appointmentId === appointmentId);
  if (!stop) throw new RequestError('That stop is not on this van today', 404, 'CREW_STOP_NOT_FOUND');
  return stop;
}

// Recording how the stop ended. `showed` and `noshow` both consume a membership credit
// downstream (see SPENDS_CREDIT in membership-crm.js); `cancelled` hands it back and
// also releases the contract's "one open visit" so the member can book again.
async function markStatus(config, resource, stop, action) {
  const status = STATUS_ACTIONS[action];
  await ghl.updateCalendarEvent(config, stop.appointmentId, { status });
  return { ok: true, appointmentId: stop.appointmentId, status };
}

// The customer would rather pay by card than in cash. Sends them a real payable
// invoice for what they declare they are paying, and hands the crew back the URL so it
// can be shown on the phone if the SMS is slow.
//
// It does NOT mark anything paid: unlike cash, the money is not in anybody's hand yet.
// The invoice is paid through HighLevel's own checkout, which is what makes it show up
// in the CRM's reporting without the crew touching a status.
async function sendPaymentLink(config, resource, stop, { amount }) {
  const invoice = await ghl.createPayableInvoice(config, {
    contactId: stop.contactId,
    title: `Pago — ${stop.title}`.slice(0, 160),
    items: [{ name: `Servicio — ${stop.title}`.slice(0, 160), amount }],
    reference: stop.appointmentId,
    // Real money at the door, so never the sandbox.
    liveMode: true
  });
  return { ok: true, appointmentId: stop.appointmentId, invoiceId: invoice.id, amount, method: 'link', paymentUrl: invoice.url };
}

// Cash taken at the door, recorded as a paid invoice so it lands in the CRM's own
// reporting instead of a note nobody can total up.
//
// The invoice is created and immediately marked paid in the same call: the money is
// already in the crew's hand, so there is never a moment where an unpaid invoice
// could reach the customer. `mode: 'cash'` is one of HighLevel's own manual payment
// modes (verified against the live API).
async function recordCash(config, resource, stop, { amount, takenBy }) {
  const invoice = await ghl.createCashInvoice(config, {
    contactId: stop.contactId,
    title: `Efectivo — ${stop.title}`.slice(0, 160),
    amount,
    reference: stop.appointmentId
  });
  await ghl.recordCashPayment(config, invoice.id, {
    amount,
    // Who took the money, so a disputed collection has a name against it.
    notes: `Cobrado en efectivo por ${takenBy || resource.key} · cita ${stop.appointmentId}`
  });
  return { ok: true, appointmentId: stop.appointmentId, invoiceId: invoice.id, amount, method: 'cash' };
}

async function handler(req, res) {
  // Read-only listing.
  if (req.method === 'GET') {
    try {
      const config = ghl.getConfig();
      const resource = resolveVan(tokenFrom(req, null), config);
      const day = await listToday(config, resource);
      return sendJson(res, 200, { ...day, stops: publicStops(day.stops) });
    } catch (error) {
      const statusCode = statusCodeFor(error, 502);
      if (statusCode >= 500) console.error('[crew-list]', error.name || 'Error', statusCode);
      return sendJson(res, statusCode, publicError(error, 'CREW_LIST_UNAVAILABLE'));
    }
  }

  if (!assertMethod(req, res, 'POST')) return undefined;

  try {
    const body = readBody(req);
    const config = ghl.getConfig();
    const resource = resolveVan(tokenFrom(req, body), config);

    const action = text(body && body.action, 'action', 3, 16);
    if (!ACTIONS.includes(action)) throw new RequestError('action is invalid', 422, 'CREW_ACTION_INVALID');
    const appointmentId = text(body && body.appointmentId, 'appointmentId', 3, 64);

    const stop = await assertTodaysStop(config, resource, appointmentId);

    if (STATUS_ACTIONS[action]) {
      console.log('[crew]', resource.key, action, appointmentId);
      return sendJson(res, 200, await markStatus(config, resource, stop, action));
    }

    // Money. The amount is the crew's declaration of what is actually being paid, which
    // is not always the expected balance — a customer may pay part, or add a tip. It is
    // validated as money and capped so a slipped digit cannot record thousands.
    const amount = Number(body && body.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > CASH_MAX) {
      throw new RequestError(`amount must be between 1 and ${CASH_MAX}`, 422, 'CREW_AMOUNT_INVALID');
    }
    const rounded = Math.round(amount * 100) / 100;

    if (action === 'payment_link') {
      console.log('[crew]', resource.key, 'payment_link', appointmentId, Math.round(amount));
      return sendJson(res, 200, await sendPaymentLink(config, resource, stop, { amount: rounded }));
    }

    const takenBy = optionalText(body && body.takenBy, 'takenBy', 60);
    console.log('[crew]', resource.key, 'cash', appointmentId, Math.round(amount));
    return sendJson(res, 200, await recordCash(config, resource, stop, { amount: rounded, takenBy }));
  } catch (error) {
    const statusCode = statusCodeFor(error, 502);
    if (statusCode >= 500) console.error('[crew-action]', error.name || 'Error', statusCode);
    return sendJson(res, statusCode, publicError(error, 'CREW_ACTION_UNAVAILABLE'));
  }
}

module.exports = handler;
module.exports._test = { moneyFromDescription, orderFromDescription, presentStop, ACTIONS, STATUS_ACTIONS, CASH_MAX };
