#!/usr/bin/env node
// Prints the personal link for one membership contract.
//
// A SCRIPT and not an endpoint, for the same reason as the crew links: printing a link
// mints a capability, so it belongs in a terminal with the secret at hand.
//
// The contract id is the CRM opportunity id, from the Memberships pipeline.
//
//   MEMBER_LINK_SECRET=… node scripts/member-link.mjs <opportunityId> [baseUrl]

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const signedLink = require('../api/_lib/signed-link.js');

const contractId = process.argv[2];
const baseUrl = (process.argv[3] || process.env.PUBLIC_APP_URL || 'https://l-b-five.vercel.app').replace(/\/$/, '');

if (!contractId) {
  console.error('Usage: MEMBER_LINK_SECRET=… node scripts/member-link.mjs <opportunityId> [baseUrl]');
  process.exit(1);
}

try {
  const token = signedLink.sign('member', contractId);
  console.log(`${baseUrl}/mi-membresia.html?t=${encodeURIComponent(token)}`);
  console.log('\nSend this to that member only. Rotating MEMBER_LINK_SECRET invalidates every member link at once.');
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
