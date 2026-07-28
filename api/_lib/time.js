'use strict';

const { RequestError } = require('./errors.js');

// The crew's working day and the grid of start times offered to customers.
const BUSINESS_DAY = Object.freeze({ start: '08:00', end: '18:00' });
const SLOT_GRID_MINUTES = 30;
const START_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DEFAULT_BOOKING_TIMEZONE = 'America/New_York';

// EVERY timestamp the agenda computes is anchored to the location's timezone —
// the one the vans and the HighLevel calendars live in — and never to whatever
// the browser reports. A customer booking from a laptop still set to UTC, or
// travelling in another zone, must get the same 9am slot the crew sees. The wire
// format is always an absolute ISO instant, so the browser's only job is to
// render it; it never gets to say what "9am" means.
function bookingTimezone() {
  const zone = String(process.env.BOOKING_TIMEZONE || '').trim() || DEFAULT_BOOKING_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch (error) {
    throw new RequestError('Booking timezone is not configured correctly', 503);
  }
  return zone;
}

function minutesFromTime(time) {
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + minute;
}

function timeFromMinutes(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function isValidDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function datesBetween(from, to) {
  const values = [];
  for (let date = from; date <= to; date = addDays(date, 1)) values.push(date);
  return values;
}

function zonedParts(timestamp, timezone = bookingTimezone()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(timestamp));
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}

// Local wall-clock date + time in the location's zone → absolute ISO instant.
// Iterates because the UTC offset itself depends on the instant (DST), so the
// first guess can land on the wrong side of a transition.
function zonedDateTimeToIso(date, time, timezone = bookingTimezone()) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = desired;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const parts = zonedParts(guess, timezone);
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0);
    guess += desired - represented;
  }
  return new Date(guess).toISOString();
}

function zonedDateTimeToMs(date, time, timezone = bookingTimezone()) {
  return Date.parse(zonedDateTimeToIso(date, time, timezone));
}

// The calendar day a given instant falls on, in the location's zone. Used to
// group assignments per day for the day-scoped lock and the busy-interval read.
function zonedDateOf(timestamp, timezone = bookingTimezone()) {
  const parts = zonedParts(timestamp, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

// Today's date in the location's zone — not the server's. A booking made at
// 22:00 in Florida must not already count as "tomorrow" because the function
// happens to run in UTC.
function todayInZone(now = Date.now(), timezone = bookingTimezone()) {
  return zonedDateOf(now, timezone);
}

function isSunday(date) {
  return new Date(`${date}T00:00:00Z`).getUTCDay() === 0;
}

// Every 30-minute start time that can still fit `durationMinutes` before the
// crew's day ends.
function gridStartTimes(durationMinutes) {
  const dayStart = minutesFromTime(BUSINESS_DAY.start);
  const dayEnd = minutesFromTime(BUSINESS_DAY.end);
  const times = [];
  for (let start = dayStart; start + durationMinutes <= dayEnd; start += SLOT_GRID_MINUTES) {
    times.push(timeFromMinutes(start));
  }
  return times;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return bStart < aEnd && aStart < bEnd;
}

function isFreeAcross(intervals, start, end) {
  return !intervals.some(interval => overlaps(start, end, interval.start, interval.end));
}

module.exports = {
  BUSINESS_DAY,
  SLOT_GRID_MINUTES,
  START_TIME_PATTERN,
  DEFAULT_BOOKING_TIMEZONE,
  bookingTimezone,
  minutesFromTime,
  timeFromMinutes,
  isValidDateOnly,
  addDays,
  datesBetween,
  zonedParts,
  zonedDateTimeToIso,
  zonedDateTimeToMs,
  zonedDateOf,
  todayInZone,
  isSunday,
  gridStartTimes,
  overlaps,
  isFreeAcross
};
