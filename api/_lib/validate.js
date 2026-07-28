'use strict';

const { RequestError } = require('./errors.js');

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const SUBMISSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{7,99}$/;

function text(value, field, min = 0, max = 160) {
  if (typeof value !== 'string') throw new RequestError(`${field} must be text`);
  const cleaned = value.trim();
  if (cleaned.length < min || cleaned.length > max) throw new RequestError(`${field} is invalid`);
  return cleaned;
}

function optionalText(value, field, max = 160) {
  if (value == null || value === '') return '';
  return text(value, field, 0, max);
}

function validateId(value, field) {
  const id = text(value, field, 1, 80);
  if (!ID_PATTERN.test(id)) throw new RequestError(`${field} is invalid`);
  return id;
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  throw new RequestError('customer.phone is invalid');
}

function validateEmail(value) {
  const email = optionalText(value, 'customer.email', 160).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new RequestError('customer.email is invalid');
  return email;
}

// A { id, name } pair from the wizard. The id is authoritative; the name is only
// ever echoed back into the CRM as a label, never used to look anything up.
function validateNamedSelection(value, field) {
  if (!value || typeof value !== 'object') throw new RequestError(`${field} is required`);
  return { id: validateId(value.id, `${field}.id`), name: text(value.name, `${field}.name`, 1, 120) };
}

module.exports = {
  ID_PATTERN,
  SUBMISSION_PATTERN,
  text,
  optionalText,
  validateId,
  normalizePhone,
  validateEmail,
  validateNamedSelection
};
