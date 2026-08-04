'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ui = require('../quote-ui-rules.js');

const membershipPackage = [{ isMembership: true }];
const oneTimePackage = [{ isMembership: false }];
const membershipRules = {
  membershipNoticeHours: 48,
  locationTimeZone: 'America/New_York'
};

// ── Paint protection as the fifth car service ──────────────────────────────

const carsCategory = {
  id: 'cars',
  packages: [
    { id: 'basico-exterior', isMembership: false },
    { id: 'basico-premium', isMembership: false },
    { id: 'premium-detail', isMembership: false },
    { id: 'vip', isMembership: false },
    { id: 'membresia-2x', isMembership: true },
    { id: 'membresia-4x', isMembership: true }
  ]
};
const paintCategory = {
  id: 'paint_correction',
  displayIn: 'cars',
  tierGroup: { id: 'paint-protection', name: { en: 'Paint Protection', es: 'Protección de Pintura' } },
  packages: [
    { id: 'paint-enhancement', isMembership: false },
    { id: 'paint-correction', isMembership: false },
    { id: 'ceramic-protection', isMembership: false }
  ]
};
const catalogCategories = [carsCategory, paintCategory, { id: 'boats', packages: [{ id: 'boat-basico', isMembership: false }] }];

test('cars offers five one-time services, the fifth being the paint doorway', () => {
  const cards = ui.serviceCards({ category: carsCategory, categories: catalogCategories, packageType: 'onetime' });

  assert.equal(cards.length, 5, 'four car packages plus one doorway');
  assert.deepEqual(cards.slice(0, 4).map(card => card.id), [
    'basico-exterior', 'basico-premium', 'premium-detail', 'vip'
  ]);

  const fifth = cards[4];
  assert.equal(fifth.kind, 'tierGroup');
  assert.equal(fifth.id, 'paint-protection');
  assert.equal(fifth.categoryId, 'paint_correction');
  // The three tiers the customer described: $299, $599 and $999.
  assert.equal(fifth.tierCount, 3);
});

test('the paint doorway opens onto exactly its three tiers', () => {
  const cards = ui.serviceCards({ category: paintCategory, categories: catalogCategories, packageType: 'onetime' });
  assert.deepEqual(cards.map(card => card.id), ['paint-enhancement', 'paint-correction', 'ceramic-protection']);
  assert.ok(cards.every(card => card.kind === 'package'));
});

test('paint protection never appears as a category of its own, but keeps its identity', () => {
  // Step 1 hides it...
  const topLevel = catalogCategories.filter(category => !category.displayIn).map(category => category.id);
  assert.deepEqual(topLevel, ['cars', 'boats']);
  // ...while a customer choosing a paint tier still reads as "inside cars".
  assert.equal(ui.displayCategoryId(paintCategory), 'cars');
  assert.equal(ui.displayCategoryId(carsCategory), 'cars');
  // But the operational category is unchanged, which is what preserves the
  // full-day duration, the $50 deposit and the paint-specific add-ons.
  assert.equal(paintCategory.id, 'paint_correction');
});

test('the membership toggle never shows a doorway', () => {
  const cards = ui.serviceCards({ category: carsCategory, categories: catalogCategories, packageType: 'membership' });
  assert.deepEqual(cards.map(card => card.id), ['membresia-2x', 'membresia-4x']);
  assert.ok(cards.every(card => card.kind === 'package'));
});

test('a category that hosts nothing is unaffected', () => {
  const boats = catalogCategories[2];
  const cards = ui.serviceCards({ category: boats, categories: catalogCategories, packageType: 'onetime' });
  assert.deepEqual(cards.map(card => card.id), ['boat-basico']);
});

test('membership notice stays at 48 hours while availability is loading', () => {
  const state = ui.scheduleUiState({
    packages: membershipPackage,
    catalogRules: membershipRules,
    availability: { loading: true, error: '', dates: [] }
  });

  assert.equal(state.isMembership, true);
  assert.equal(state.membershipNoticeHours, 48);
  assert.equal(state.dateHintKey, 'form.dateHintMembership');
  assert.equal(state.canSelectDateTime, false);
  assert.deepEqual(state.dates, []);
});

test('membership notice stays at 48 hours and disables selection after availability 502', () => {
  const state = ui.scheduleUiState({
    packages: membershipPackage,
    catalogRules: membershipRules,
    availability: { loading: false, error: 'Calendar temporarily unavailable', dates: [] }
  });

  assert.equal(state.dateHintKey, 'form.dateHintMembership');
  assert.equal(state.membershipNoticeHours, 48);
  assert.equal(state.canSelectDateTime, false);
});

test('membership accepts only slots returned by availability and honors a server-issued minimum date', () => {
  const availability = {
    loading: false,
    error: '',
    bookingMode: 'timed',
    dates: [
      { date: '2026-08-01', slots: [{ start: '09:00' }] },
      { date: '2026-08-03', slots: [{ start: '09:00' }, { start: '11:00' }] }
    ]
  };
  const state = ui.scheduleUiState({
    packages: membershipPackage,
    catalogRules: { ...membershipRules, minimumDate: '2026-08-03' },
    availability
  });

  assert.deepEqual(state.dates.map(day => day.date), ['2026-08-03']);
  assert.equal(ui.selectedSlotIsAuthorized({
    availability,
    dates: state.dates,
    date: '2026-08-01',
    timeWindow: '09:00'
  }), false);
  assert.equal(ui.selectedSlotIsAuthorized({
    availability,
    dates: state.dates,
    date: '2026-08-03',
    timeWindow: '11:00'
  }), true);
  assert.equal(ui.selectedSlotIsAuthorized({
    availability,
    dates: state.dates,
    date: '2026-08-03',
    timeWindow: '08:00'
  }), false);
});

test('one-time services retain the normal notice policy', () => {
  const state = ui.scheduleUiState({
    packages: oneTimePackage,
    catalogRules: membershipRules,
    availability: { loading: true, error: '', dates: [] }
  });

  assert.equal(state.isMembership, false);
  assert.equal(state.dateHintKey, 'form.dateHint');
  assert.equal(state.canSelectDateTime, false);
});

test('four vehicles disables another vehicle while preserving the cart and rejecting a fifth', () => {
  const existing = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
  const limit = ui.cartLimitState(existing.length, 4);
  assert.deepEqual(limit, { atLimit: true, canAdd: false });

  const rejected = ui.appendCartLine(existing, { id: 5 }, 4);
  assert.equal(rejected.added, false);
  assert.deepEqual(rejected.lines, existing);
  assert.equal(ui.cartLimitState(3, 4).canAdd, true);
});

test('the quote keeps the required bilingual four-vehicle limit copy', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'script.js'), 'utf8');
  assert.match(source, /Límite alcanzado: una reserva puede incluir 4 vehículos\. Aún puedes editar o quitar un vehículo\./);
  assert.match(source, /Maximum reached: one reservation can include 4 vehicles\. You can still edit or remove a vehicle\./);
});

test('removing a cart line refreshes the limit control immediately', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'script.js'), 'utf8');
  const removeCartLine = source.slice(source.indexOf('function removeCartLine('), source.indexOf('function editCartLine('));
  assert.match(removeCartLine, /renderCartPanel\(\);[\s\S]*?updateStepUI\(\);/);
});
