#!/usr/bin/env node

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { OPPORTUNITY_FIELDS } = require('../api/quote.js')._test;

const BASE_URL = 'https://services.leadconnectorhq.com';
const PIPELINE_NAME = 'Website Quotes';
const FALLBACK_PIPELINE_NAME = 'Website Quotes - L&B';
const STAGE_NAME = 'New Quote';
const token = process.env.GHL_PRIVATE_TOKEN;
const locationId = process.env.GHL_LOCATION_ID;

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
  let pipeline = pipelines.find(item => String(item.name || '').toLowerCase() === PIPELINE_NAME.toLowerCase());

  async function createPipeline(name) {
    console.log(`Creating pipeline "${name}" without altering existing pipelines…`);
    const created = await request('/opportunities/pipelines', {
      method: 'POST',
      body: {
        locationId,
        name,
        stages: [{ name: STAGE_NAME, position: 0 }]
      }
    });
    const result = created.pipeline || created;
    if (result.id && !Array.isArray(result.stages)) {
      const refreshed = await request(`/opportunities/pipelines/${encodeURIComponent(result.id)}`);
      return refreshed.pipeline || refreshed;
    }
    return result;
  }

  if (!pipeline) {
    pipeline = await createPipeline(PIPELINE_NAME);
  }

  let stage = (pipeline.stages || []).find(item => String(item.name || '').toLowerCase() === STAGE_NAME.toLowerCase());
  if (!stage) {
    // Do not rewrite an existing pipeline because HighLevel replaces the full
    // stage array on updates. Use a dedicated fallback instead.
    pipeline = pipelines.find(item => String(item.name || '').toLowerCase() === FALLBACK_PIPELINE_NAME.toLowerCase());
    if (!pipeline) pipeline = await createPipeline(FALLBACK_PIPELINE_NAME);
    stage = (pipeline.stages || []).find(item => String(item.name || '').toLowerCase() === STAGE_NAME.toLowerCase());
  }
  if (!pipeline.id || !stage.id) throw new Error('HighLevel did not return the pipeline and stage IDs.');
  return { pipelineId: pipeline.id, pipelineStageId: stage.id };
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
  console.log('\nHighLevel setup complete. Add these server-only variables to Vercel:');
  console.log(`GHL_LOCATION_ID=${locationId}`);
  console.log(`GHL_PIPELINE_ID=${pipeline.pipelineId}`);
  console.log(`GHL_PIPELINE_STAGE_ID=${pipeline.pipelineStageId}`);
  console.log(`Verified ${Object.keys(fieldIds).length} opportunity fields.`);
} catch (error) {
  console.error(`HighLevel setup failed: ${error.message}`);
  process.exit(1);
}
