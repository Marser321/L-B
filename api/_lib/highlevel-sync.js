'use strict';

// Pushing membership state into HighLevel, idempotently.
//
// HighLevel is the CRM the office actually looks at, so it has to reflect what
// the database decided. It is NOT an authority: nothing here reads a value back
// out of HighLevel and treats it as true.
//
// Idempotency is by content hash in highlevel_sync_state. Every push computes a
// hash of what it is about to send; if the stored hash matches, the call is
// skipped entirely. So re-running a sync after a Stripe redelivery, a retry, or a
// manual re-trigger produces exactly one contact, one membership opportunity per
// vehicle, and one calendar event per confirmed parent booking.

const crypto = require('node:crypto');

const ghl = require('./ghl.js');
const { getRepository } = require('./repository.js');

// Opportunity custom fields that carry membership state into the CRM. Optional
// everywhere: a location that has not been provisioned yet still syncs the rest
// rather than failing the whole push.
const MEMBERSHIP_FIELDS = Object.freeze({
  membershipStatus: 'Website Quote - Membership Status',
  membershipPackage: 'Website Quote - Membership Package',
  membershipCredits: 'Website Quote - Membership Credits',
  membershipRenewal: 'Website Quote - Membership Renewal',
  membershipVehicle: 'Website Quote - Membership Vehicle',
  membershipContractId: 'Website Quote - Membership Contract'
});

function hashPayload(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
}

function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { firstName: parts[0] || '', lastName: '' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

// Resolves the membership custom-field ids once per process. Missing fields are
// simply absent from the map — see the note above about not failing the push.
let fieldPromise = null;
async function membershipFieldIds(config) {
  if (!fieldPromise) {
    fieldPromise = (async () => {
      const data = await ghl.ghlRequest(
        config,
        `/locations/${encodeURIComponent(config.locationId)}/customFields?model=opportunity`
      );
      const fields = data.customFields || [];
      const ids = {};
      for (const [key, name] of Object.entries(MEMBERSHIP_FIELDS)) {
        const match = fields.find(field =>
          field.model === 'opportunity' && String(field.name || '').toLowerCase() === name.toLowerCase()
        );
        if (match) ids[key] = match.id;
      }
      return ids;
    })().catch(error => {
      fieldPromise = null;
      throw error;
    });
  }
  return fieldPromise;
}

// One contact per account holder.
async function syncContact(config, { customer, tx }) {
  const payload = {
    name: customer.name || '',
    email: customer.email || '',
    phone: customer.phone || ''
  };
  const localKey = `customer:${customer.id}`;
  const hash = hashPayload(payload);
  const state = await tx.getHighLevelSync('contact', localKey);
  if (state && state.payloadHash === hash && state.externalId) {
    return { contactId: state.externalId, skipped: true };
  }

  const names = splitName(payload.name);
  const result = await ghl.ghlRequest(config, '/contacts/upsert', {
    method: 'POST',
    version: '2021-07-28',
    body: {
      locationId: config.locationId,
      name: payload.name,
      firstName: names.firstName,
      lastName: names.lastName,
      ...(payload.email ? { email: payload.email } : {}),
      ...(payload.phone ? { phone: payload.phone } : {}),
      source: 'L&B Membership',
      assignedTo: config.assignedUserId,
      createNewIfDuplicateAllowed: false
    }
  });
  const contact = result.contact || result;
  if (!contact || !contact.id) throw new Error('HighLevel returned no contact id');

  await tx.upsertHighLevelSync('contact', localKey, { externalId: contact.id, payloadHash: hash });
  return { contactId: contact.id, skipped: false };
}

// One opportunity per VEHICLE contract, so the office sees four rows for a
// four-vehicle household and can work them independently.
async function syncContractOpportunity(config, { contract, contactId, customer, tx }) {
  const fieldIds = await membershipFieldIds(config).catch(() => ({}));
  const values = {
    membershipStatus: contract.status,
    membershipPackage: `${contract.packageId} / ${contract.sizeId}`,
    membershipCredits: `${contract.creditsRemaining} of ${contract.creditsPerCycle}`,
    membershipRenewal: contract.currentPeriodEndMs ? new Date(contract.currentPeriodEndMs).toISOString().slice(0, 10) : '',
    membershipVehicle: contract.vehicleLabel || '',
    membershipContractId: contract.id
  };
  const customFields = Object.entries(values)
    .filter(([key, value]) => value !== '' && fieldIds[key])
    .map(([key, value]) => ({ id: fieldIds[key], fieldValue: String(value) }));

  const localKey = `contract:${contract.id}`;
  const hash = hashPayload({ values, contactId });
  const state = await tx.getHighLevelSync('membership_opportunity', localKey);
  if (state && state.payloadHash === hash && state.externalId) {
    return { opportunityId: state.externalId, skipped: true };
  }

  const name = `Membership — ${contract.vehicleLabel || contract.packageId} — ${customer.name || ''}`.slice(0, 160);
  let opportunityId = (state && state.externalId) || contract.ghlOpportunityId || null;

  if (opportunityId) {
    // Already exists: update in place rather than creating a second one.
    await ghl.ghlRequest(config, `/opportunities/${encodeURIComponent(opportunityId)}`, {
      method: 'PUT',
      version: 'v3',
      body: {
        name,
        monetaryValue: Math.round(contract.monthlyCents / 100),
        assignedTo: config.assignedUserId,
        ...(customFields.length ? { customFields } : {})
      }
    });
  } else {
    const result = await ghl.ghlRequest(config, '/opportunities/', {
      method: 'POST',
      version: 'v3',
      body: {
        pipelineId: config.pipelineId,
        pipelineStageId: config.pipelineStageId,
        locationId: config.locationId,
        contactId,
        name,
        status: 'open',
        assignedTo: config.assignedUserId,
        monetaryValue: Math.round(contract.monthlyCents / 100),
        ...(customFields.length ? { customFields } : {})
      }
    });
    const opportunity = result.opportunity || result;
    if (!opportunity || !opportunity.id) throw new Error('HighLevel returned no opportunity id');
    opportunityId = opportunity.id;
  }

  await tx.upsertHighLevelSync('membership_opportunity', localKey, { externalId: opportunityId, payloadHash: hash });
  await tx.updateContract(contract.id, { ghlOpportunityId: opportunityId });
  return { opportunityId, skipped: false };
}

// Exactly one calendar event for a confirmed parent booking, however many
// vehicles it covers and however many times the sync runs.
async function syncParentBookingEvent(config, { parentBookingId, contactId, title, description, address, startMs, endMs, calendarId, tx }) {
  const localKey = `parent_booking:${parentBookingId}`;
  const hash = hashPayload({ startMs, endMs, calendarId, contactId });
  const state = await tx.getHighLevelSync('parent_booking_event', localKey);
  if (state && state.externalId) {
    // The event already exists. Re-running must never create a second one, even
    // if details changed — those are pushed by the agenda's own assignment sync.
    return { eventId: state.externalId, skipped: true };
  }

  const event = await ghl.createCalendarEvent(config, {
    calendarId,
    contactId,
    title,
    description,
    address,
    startTime: new Date(startMs).toISOString(),
    endTime: new Date(endMs).toISOString()
  });

  await tx.upsertHighLevelSync('parent_booking_event', localKey, { externalId: event.id, payloadHash: hash });
  return { eventId: event.id, skipped: false };
}

// Convenience wrapper used by the webhook: sync the contact once, then every
// contract that belongs to it. Failures are logged and swallowed — HighLevel
// being down must not make Stripe redeliver an event we already applied.
async function syncMembership({ customer, contracts, config = null }) {
  const repository = getRepository();
  let activeConfig = config;
  if (!activeConfig) {
    try { activeConfig = ghl.getConfig(); } catch (error) {
      console.error('[hl-sync] CRM not configured; skipping');
      return { skipped: true };
    }
  }

  try {
    return await repository.transaction([`hlsync:${customer.id}`], async tx => {
      const contact = await syncContact(activeConfig, { customer, tx });
      const results = [];
      for (const contract of contracts) {
        results.push(await syncContractOpportunity(activeConfig, {
          contract, contactId: contact.contactId, customer, tx
        }));
      }
      return { contactId: contact.contactId, opportunities: results };
    });
  } catch (error) {
    console.error('[hl-sync] failed', customer.id, error.message);
    return { failed: true, error: error.message };
  }
}

module.exports = {
  MEMBERSHIP_FIELDS,
  hashPayload,
  syncContact,
  syncContractOpportunity,
  syncParentBookingEvent,
  syncMembership,
  resetFieldCache: () => { fieldPromise = null; }
};
