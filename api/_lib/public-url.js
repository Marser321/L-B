'use strict';

const { RequestError } = require('./errors.js');

function publicAppUrl() {
  const raw = String(process.env.PUBLIC_APP_URL || 'https://l-b-five.vercel.app').trim();
  let url;
  try { url = new URL(raw); } catch { throw new RequestError('PUBLIC_APP_URL is invalid', 503, 'PUBLIC_APP_URL_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new RequestError('PUBLIC_APP_URL is invalid', 503, 'PUBLIC_APP_URL_INVALID');
  }
  return url.origin;
}

module.exports = { publicAppUrl };
