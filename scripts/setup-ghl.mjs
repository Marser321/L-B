#!/usr/bin/env node

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { OPPORTUNITY_FIELDS } = require('../api/quote.js')._test;

const BASE_URL = 'https://services.leadconnectorhq.com';
const PIPELINE_NAME = 'Pipeline de Servicios';
const STAGE_NAME = 'Pendiente de Información';
const CONFIRMED_STAGE_NAME = 'Cita Confirmada';
const CALENDAR_NAME = 'Website Bookings — Mobile Team';
const token = process.env.GHL_PRIVATE_TOKEN;
const locationId = process.env.GHL_LOCATION_ID;
const configuredCalendarId = process.env.GHL_CALENDAR_ID || '';
const assignedUserId = process.env.GHL_ASSIGNED_USER_ID || '';

if (!token || !locationId) {
  console.error('Set GHL_PRIVATE_TOKEN and GHL_LOCATION_ID before running this setup.');
  process.exit(1);
}

async function request(path, { method = 'GET', body, version = 'v3' } = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      Version: version,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = Array.isArray(data.message) ? data.message.join(', ') : (data.message || response.statusText);
    throw new Error(`${method} ${path} failed (${response.status}): ${message}`);
  }
  return data;
}

async function ensurePipeline() {
  const data = await request(`/opportunities/pipelines?locationId=${encodeURIComponent(locationId)}`);
  const pipelines = data.pipelines || [];
  const pipeline = pipelines.find(item => String(item.name || '').toLowerCase() === PIPELINE_NAME.toLowerCase());
  if (!pipeline) throw new Error(`Required pipeline "${PIPELINE_NAME}" does not exist.`);
  const stage = (pipeline.stages || []).find(item => String(item.name || '').toLowerCase() === STAGE_NAME.toLowerCase());
  const confirmedStage = (pipeline.stages || []).find(item => String(item.name || '').toLowerCase() === CONFIRMED_STAGE_NAME.toLowerCase());
  if (!stage) throw new Error(`Required stage "${STAGE_NAME}" does not exist in "${PIPELINE_NAME}".`);
  if (!confirmedStage) throw new Error(`Create the stage "${CONFIRMED_STAGE_NAME}" in "${PIPELINE_NAME}" and run setup again.`);
  return { pipelineId: pipeline.id, pipelineStageId: stage.id, confirmedPipelineStageId: confirmedStage.id };
}

async function ensureCalendar() {
  const data = await request(`/calendars/?locationId=${encodeURIComponent(locationId)}&showDrafted=true`);
  let calendar = (data.calendars || []).find(item =>
    (configuredCalendarId && item.id === configuredCalendarId) ||
    String(item.name || '').toLowerCase() === CALENDAR_NAME.toLowerCase()
  );

  if (!calendar) {
    if (!assignedUserId) {
      throw new Error(`Set GHL_ASSIGNED_USER_ID so setup can create "${CALENDAR_NAME}".`);
    }
    console.log(`Creating calendar "${CALENDAR_NAME}"…`);
    const created = await request('/calendars/', {
      method: 'POST',
      body: {
        locationId,
        name: CALENDAR_NAME,
        description: 'Confirmed bookings created by the L&B Elite Wash website.',
        slug: 'website-bookings-mobile-team',
        calendarType: 'round_robin',
        eventType: 'RoundRobin_OptimizeForAvailability',
        teamMembers: [{ userId: assignedUserId, priority: 1, isPrimary: true }],
        eventTitle: '{{contact.name}} — Mobile Service',
        slotDuration: 3,
        slotDurationUnit: 'hours',
        slotInterval: 4,
        slotIntervalUnit: 'hours',
        slotBuffer: 1,
        slotBufferUnit: 'hours',
        appoinmentPerSlot: 1,
        appoinmentPerDay: 3,
        allowBookingAfter: 24,
        allowBookingAfterUnit: 'hours',
        allowBookingFor: 60,
        allowBookingForUnit: 'days',
        autoConfirm: true,
        allowReschedule: true,
        allowCancellation: true,
        shouldAssignContactToTeamMember: true,
        shouldSkipAssigningContactForExisting: false,
        shouldSendAlertEmailsToAssignedMember: true
      }
    });
    calendar = created.calendar || created;
    if (!calendar.id) throw new Error('HighLevel did not return an ID for the new calendar.');

    const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    await request(`/calendars/schedules/event-calendar/${encodeURIComponent(calendar.id)}`, {
      method: 'POST',
      version: '2021-07-28',
      body: {
        timezone: 'America/New_York',
        rules: weekdays.map(day => ({ type: 'wday', day, intervals: [{ from: '08:00', to: '20:00' }] }))
      }
    });
  }

  const members = calendar.teamMembers || [];
  const resolvedUserId = assignedUserId || (members.find(member => member.isPrimary) || members[0] || {}).userId;
  if (!resolvedUserId) throw new Error(`Calendar "${CALENDAR_NAME}" must have one assigned team member.`);
  if (assignedUserId && members.length && !members.some(member => member.userId === assignedUserId)) {
    throw new Error(`GHL_ASSIGNED_USER_ID is not assigned to calendar "${CALENDAR_NAME}".`);
  }
  if (calendar.isActive === false) throw new Error(`Calendar "${CALENDAR_NAME}" is not active.`);
  return { calendarId: calendar.id, assignedUserId: resolvedUserId };
}

async function ensureCustomFields() {
  const data = await request(`/locations/${encodeURIComponent(locationId)}/customFields?model=opportunity`);
  const fields = data.customFields || [];
  const fieldIds = {};

  for (const [key, name] of Object.entries(OPPORTUNITY_FIELDS)) {
    let field = fields.find(item => String(item.name || '').toLowerCase() === name.toLowerCase());
    if (field && field.dataType !== 'TEXT') {
      throw new Error(`Custom field "${name}" exists but is ${field.dataType}; it must be TEXT.`);
    }
    if (!field) {
      console.log(`Creating opportunity field "${name}"…`);
      const created = await request(`/locations/${encodeURIComponent(locationId)}/customFields`, {
        method: 'POST',
        body: { name, dataType: 'TEXT', model: 'opportunity', placeholder: name }
      });
      field = created.customField || created;
      fields.push(field);
    }
    if (!field.id) throw new Error(`HighLevel did not return an ID for "${name}".`);
    fieldIds[key] = field.id;
  }
  return fieldIds;
}

try {
  console.log('Auditing the HighLevel sub-account…');
  const pipeline = await ensurePipeline();
  const fieldIds = await ensureCustomFields();
  const calendar = await ensureCalendar();
  console.log('\nHighLevel setup complete. Add these server-only variables to Vercel:');
  console.log(`GHL_LOCATION_ID=${locationId}`);
  console.log(`GHL_PIPELINE_ID=${pipeline.pipelineId}`);
  console.log(`GHL_PIPELINE_STAGE_ID=${pipeline.pipelineStageId}`);
  console.log(`GHL_CONFIRMED_PIPELINE_STAGE_ID=${pipeline.confirmedPipelineStageId}`);
  console.log(`GHL_CALENDAR_ID=${calendar.calendarId}`);
  console.log(`GHL_ASSIGNED_USER_ID=${calendar.assignedUserId}`);
  console.log(`Verified ${Object.keys(fieldIds).length} opportunity fields.`);
} catch (error) {
  console.error(`HighLevel setup failed: ${error.message}`);
  process.exit(1);
}
