'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { databaseConnectionString } = require('../api/_lib/database-url.js');

test('database connection keeps certificate verification unless no-verify is explicitly configured', () => {
  const source = 'postgresql://user:pass@db.example.test:5432/app?sslmode=require';
  assert.equal(databaseConnectionString(source), source);
  assert.match(databaseConnectionString(source, 'no-verify'), /sslmode=no-verify/);
  assert.doesNotMatch(databaseConnectionString(source, 'no-verify'), /sslmode=require/);
});

test('database connection leaves an absent URL absent', () => {
  assert.equal(databaseConnectionString('', 'no-verify'), '');
});
