'use strict';

// Error types shared by every endpoint. RequestError carries the HTTP status the
// caller should see; anything else surfaces as a 502 with a generic message so an
// internal failure never leaks its shape to the browser.

class RequestError extends Error {
  constructor(message, statusCode = 400, code = 'REQUEST_INVALID') {
    super(message);
    this.name = 'RequestError';
    this.statusCode = statusCode;
    // The human message is kept for existing integrations. New clients should
    // branch on this stable, non-localised code instead of parsing copy.
    this.code = code;
  }
}

// The request was understood but cannot be processed with the supplied booking
// data. Keep malformed transport (JSON, body too large) as a 4xx of its own,
// but make every catalog/cart/field validation consistently return 422.
class ValidationError extends RequestError {
  constructor(message, code = 'REQUEST_INVALID') {
    super(message, 422, code);
    this.name = 'ValidationError';
  }
}

function asValidationError(error) {
  if (error instanceof RequestError && error.statusCode === 400) {
    return new ValidationError(error.message, error.code);
  }
  return error;
}

class HighLevelError extends Error {
  constructor(upstreamStatus, statusCode = 502, upstreamHint = '', diagnosticMessage = '') {
    super(`HighLevel request failed (${upstreamStatus})`);
    this.name = 'HighLevelError';
    this.statusCode = statusCode;
    this.upstreamStatus = upstreamStatus;
    // Deliberately limited to whitelisted schema field names. Never copy an
    // upstream message: invoice/contact error messages may echo PII.
    this.upstreamHint = upstreamHint;
    this.diagnosticMessage = diagnosticMessage;
    this.code = 'UPSTREAM_UNAVAILABLE';
  }
}

class SlotUnavailableError extends RequestError {
  constructor(message = 'The selected appointment is no longer available') {
    super(message, 409, 'SLOT_UNAVAILABLE');
    this.name = 'SlotUnavailableError';
  }
}

// More vehicles than the fleet can ever serve in one visit. Distinct from a
// malformed cart (400) because the request is well-formed but unprocessable:
// four vans means four vehicles, full stop.
class TooManyVehiclesError extends RequestError {
  constructor(maxVehicles) {
    super(`A single booking can include at most ${maxVehicles} vehicles`, 422, 'MAX_VEHICLES_EXCEEDED');
    this.name = 'TooManyVehiclesError';
    this.maxVehicles = maxVehicles;
  }
}

// The same Idempotency-Key was reused with a different request body. Replaying a
// key must return the original result, never quietly hold a different slot.
class IdempotencyConflictError extends RequestError {
  constructor() {
    super('This Idempotency-Key was already used for a different request', 409, 'IDEMPOTENCY_CONFLICT');
    this.name = 'IdempotencyConflictError';
  }
}

module.exports = {
  RequestError,
  ValidationError,
  asValidationError,
  HighLevelError,
  SlotUnavailableError,
  TooManyVehiclesError,
  IdempotencyConflictError
};
