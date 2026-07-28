'use strict';

// Every outbound message goes through here, and every one of them carries a
// dedupe key describing WHAT it is about — never when it was sent.
//
// This matters because both of our upstreams retry aggressively and neither is
// apologetic about it: Stripe redelivers a webhook until it gets a 2xx, and a
// HighLevel workflow can fire again on a re-sync. Without a claim step, a customer
// gets three "your membership is active" texts and the office gets three pings.
//
// The claim is `insert … on conflict do nothing` on notification_deliveries. The
// first caller to insert the key owns the send; everyone else is told the message
// already exists and does nothing. The row is written BEFORE the send, so a crash
// mid-send leaves a `pending` row that is visible and never silently re-sent.

const crypto = require('node:crypto');

const { getRepository } = require('./repository.js');

const NOTIFICATION_TIMEOUT_MS = 5 * 1000;

// Which HighLevel inbound-workflow URL serves which template. All optional: an
// unset endpoint means the notification is recorded and marked `suppressed`, so
// the audit trail still shows what would have been sent.
function endpoints() {
  return {
    sms: String(process.env.GHL_WORKFLOW_SMS_URL || '').trim(),
    email: String(process.env.GHL_WORKFLOW_EMAIL_URL || '').trim(),
    internal: String(process.env.GHL_WORKFLOW_INTERNAL_URL || '').trim(),
    webhook: String(process.env.GHL_WORKFLOW_WEBHOOK_URL || '').trim()
  };
}

// Dedupe keys are built, never passed in raw, so two call sites cannot disagree
// about what "the same message" means.
const keys = {
  membershipActivated: contractId => `membership:${contractId}:activated`,
  membershipRenewed: (contractId, invoiceId) => `membership:${contractId}:renewed:${invoiceId}`,
  membershipPaymentFailed: (contractId, invoiceId) => `membership:${contractId}:payment_failed:${invoiceId}`,
  membershipCancelScheduled: (contractId, periodEndMs) => `membership:${contractId}:cancel_scheduled:${periodEndMs}`,
  membershipCanceled: contractId => `membership:${contractId}:canceled`,
  creditExhausted: (contractId, cycleStartMs) => `membership:${contractId}:credits_exhausted:${cycleStartMs}`,
  // One notification per confirmed PARENT booking, not per vehicle: a four-vehicle
  // visit is one appointment for the customer, so it is one message.
  bookingConfirmed: parentBookingId => `booking:${parentBookingId}:confirmed`,
  visitCancelledLate: visitId => `visit:${visitId}:cancelled_late`,
  visitNoShow: visitId => `visit:${visitId}:no_show`
};

async function postJson(url, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NOTIFICATION_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`workflow responded ${response.status}`);
    return true;
  } finally {
    clearTimeout(timer);
  }
}

// Claims the key and sends, or reports that someone already did.
//
// Returns { sent, duplicate, suppressed }. A `duplicate` is a success from the
// caller's point of view: the customer has been told.
async function notify({ dedupeKey, channel, template, recipient = null, context = {} }) {
  const repository = getRepository();

  // Deliberately its own transaction rather than joining the caller's: the send
  // happens over the network straight after, and a message that has gone out
  // cannot be rolled back. Claiming separately means the worst case is a recorded
  // message for a change that was rolled back — visible in the table — rather than
  // a customer told about something that never happened.
  const claimed = await repository.transaction([`notify:${dedupeKey}`], async transaction =>
    transaction.insertNotification({
      id: crypto.randomUUID(),
      dedupeKey,
      channel,
      template,
      recipient,
      context
    })
  );

  if (!claimed.inserted) return { sent: false, duplicate: true, suppressed: false };

  const url = endpoints()[channel];
  if (!url) {
    // Recorded, not delivered. Better than pretending: the row shows the office
    // exactly which message did not go out and why.
    await repository.transaction([`notify:${dedupeKey}`], async transaction => {
      await transaction.markNotificationFailed(dedupeKey, 'no endpoint configured');
    });
    return { sent: false, duplicate: false, suppressed: true };
  }

  try {
    await postJson(url, { template, recipient, dedupeKey, ...context });
    await repository.transaction([`notify:${dedupeKey}`], async transaction => {
      await transaction.markNotificationSent(dedupeKey, null);
    });
    return { sent: true, duplicate: false, suppressed: false };
  } catch (error) {
    console.error('[notify]', template, dedupeKey, error.message);
    await repository.transaction([`notify:${dedupeKey}`], async transaction => {
      await transaction.markNotificationFailed(dedupeKey, error.message);
    });
    // Never rethrown: a webhook that already changed the database must still
    // return 2xx, or Stripe will redeliver and try to change it again.
    return { sent: false, duplicate: false, suppressed: false, failed: true };
  }
}

module.exports = { keys, notify, endpoints, NOTIFICATION_TIMEOUT_MS };
