#!/usr/bin/env node
// Prints the standing link for each van, once, for the operator to hand out.
//
// Deliberately a SCRIPT and not an endpoint: printing a link mints a capability that
// can mark money collected, so it belongs in a terminal with the secret at hand, not
// on the web where something could be tricked into serving it.
//
//   CREW_LINK_SECRET=… GHL_CALENDAR_CAMIONETA_1=… … node scripts/crew-links.mjs
//   CREW_LINK_SECRET=… … node scripts/crew-links.mjs https://lybelitewash.com

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const ghl = require('../api/_lib/ghl.js');
const crewLink = require('../api/_lib/crew-link.js');

const baseUrl = process.argv[2] || 'https://lybelitewash.com';

try {
  const links = crewLink.allLinks(ghl.resources(), baseUrl);
  console.log(`Crew links for ${baseUrl} — hand each one to its own crew, and to nobody else.\n`);
  for (const link of links) console.log(`${link.resourceKey.padEnd(14)} ${link.url}`);
  console.log('\nRotating CREW_LINK_SECRET invalidates every link above at once.');
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
