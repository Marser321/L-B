'use strict';

// The crew's standing link: one URL per van, kept on the crew's phone.
//
// The mechanism lives in signed-link.js and is shared with the member link; only the
// purpose differs, which is what makes a crew token unusable as a member token. See
// that file for what the scheme does and does not do (no expiry, no per-link
// revocation), and api/crew.js for the limits that actually bound the capability.

const signedLink = require('./signed-link.js');

function sign(resourceKey) {
  return signedLink.sign('crew', resourceKey);
}

function verify(token) {
  return signedLink.verify('crew', token);
}

// Every van's link, for the operator to hand out once. Never exposed by an endpoint
// the crew can reach: printing a link mints a capability, so this is for a local
// terminal and the CRM, not for the web.
function allLinks(resources, baseUrl = 'https://lybelitewash.com') {
  return resources.map(resource => ({
    resourceKey: resource.key,
    url: `${baseUrl.replace(/\/$/, '')}/cuadrilla.html?t=${encodeURIComponent(sign(resource.key))}`
  }));
}

module.exports = { sign, verify, allLinks };
