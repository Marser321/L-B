/*
 * Presentation-only rules shared by the vanilla browser code and Node tests.
 *
 * This module intentionally has no package identifiers, prices, durations,
 * hard-coded capacity rules, or clock arithmetic. Those come from the server
 * catalog and availability response. It only presents server-authorized state
 * in the quote UI.
 */
(function exposeQuoteUiRules(root, factory) {
  const rules = factory();
  if (typeof module === 'object' && module.exports) module.exports = rules;
  if (root) root.LybQuoteUiRules = rules;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createQuoteUiRules() {
  function validDateOnly(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  }

  function hasMembership(packages) {
    return Array.isArray(packages) && packages.some(pkg => pkg && pkg.isMembership === true);
  }

  // The minimum date, when present, has already been calculated by the API in
  // the location timezone. We only filter the API's own choices; we never
  // calculate a date from the browser clock.
  function authorizedDates(dates, minimumDate) {
    const minimum = validDateOnly(minimumDate) ? minimumDate : '';
    return (Array.isArray(dates) ? dates : []).filter(day =>
      day && validDateOnly(day.date) && (!minimum || day.date >= minimum)
    );
  }

  function scheduleUiState({ packages, catalogRules, availability }) {
    const rules = catalogRules || {};
    const source = availability || {};
    const membership = hasMembership(packages);
    const membershipNoticeHours = Number(rules.membershipNoticeHours) || 0;
    const dates = authorizedDates(source.dates, rules.minimumDate);
    const canSelectDateTime = !source.loading && !source.error && dates.length > 0;

    return {
      isMembership: membership,
      membershipNoticeHours,
      dateHintKey: membership && membershipNoticeHours > 0 ? 'form.dateHintMembership' : 'form.dateHint',
      dates,
      canSelectDateTime
    };
  }

  function selectedSlotIsAuthorized({ availability, dates, date, timeWindow }) {
    const source = availability || {};
    if (source.loading || source.error || !date || !timeWindow) return false;
    const day = (Array.isArray(dates) ? dates : []).find(item => item.date === date);
    if (!day) return false;
    if (source.bookingMode === 'full_day') return timeWindow === 'full_day';
    return (Array.isArray(day.slots) ? day.slots : []).some(slot => {
      const start = typeof slot === 'string' ? slot : slot && slot.start;
      return start === timeWindow;
    });
  }

  // Whether a package may join the cart as it stands, and why not when it may not.
  //
  // Two services own a whole checkout on their own, for different reasons:
  //
  //   membership  a recurring agreement, its own contract and its own payment
  //   fullDay     paint protection, which holds the van from 8am to 6pm
  //
  // Both were only enforced server-side. The membership case at least failed
  // loudly; the full-day one did not — the cart accepted paint next to a car, and
  // the customer then saw every date in the calendar come back empty, with nothing
  // saying why. The rule belongs here, before the line is added.
  //
  // `packages` is the cart's resolved metadata, same shape as hasMembership takes.
  function cartCombination({ packages, candidate }) {
    const lines = Array.isArray(packages) ? packages : [];
    const pkg = candidate || {};
    if (!lines.length) return { canAdd: true, reasonKey: '' };
    if (pkg.isMembership === true) return { canAdd: false, reasonKey: 'cart.membershipAlone' };
    if (lines.some(line => line && line.isMembership === true)) return { canAdd: false, reasonKey: 'cart.membershipAlone' };
    if (pkg.fullDay === true) return { canAdd: false, reasonKey: 'cart.fullDayAlone' };
    if (lines.some(line => line && line.fullDay === true)) return { canAdd: false, reasonKey: 'cart.fullDayAlone' };
    return { canAdd: true, reasonKey: '' };
  }

  function cartLimitState(cartCount, maxVehicles) {
    const count = Number(cartCount);
    const max = Number(maxVehicles);
    const valid = Number.isInteger(count) && count >= 0 && Number.isInteger(max) && max > 0;
    const atLimit = valid && count >= max;
    return { atLimit, canAdd: valid && !atLimit };
  }

  function appendCartLine(lines, line, maxVehicles) {
    const existing = Array.isArray(lines) ? lines : [];
    if (!cartLimitState(existing.length, maxVehicles).canAdd) {
      return { added: false, lines: existing.slice() };
    }
    return { added: true, lines: existing.concat([line]) };
  }

  // Which services a category shows, given the whole catalog.
  //
  // A category may be sold INSIDE another one: paint protection is the fifth car
  // service rather than a line of business of its own. It is still its own
  // category everywhere that matters — duration, deposit, add-ons — and only the
  // first two screens present it as belonging to cars. That split is why this is a
  // presentation rule and not a catalog change.
  //
  // Returns cards in display order: the category's own packages first, then one
  // `tierGroup` doorway per hosted category.
  //
  // `cartHasLines` hides everything that cannot join a cart that already has a
  // vehicle in it — today that is the full-day paint tiers and their doorway. A
  // customer who never sees the card never builds the one cart the server has to
  // refuse, which is how the "no availability on any date" dead end is closed at
  // the only place it reads as a normal product rule rather than an error.
  function serviceCards({ category, categories, packageType = 'onetime', cartHasLines = false }) {
    if (!category) return [];
    const all = Array.isArray(categories) ? categories : [];
    const bookableNow = pkg => !cartHasLines || pkg.fullDay !== true;
    const own = (category.packages || [])
      .filter(pkg => (pkg.isMembership ? 'membership' : 'onetime') === packageType)
      .filter(bookableNow)
      .map(pkg => ({ kind: 'package', id: pkg.id, package: pkg }));

    // Memberships are never sold through a doorway: the toggle already separates
    // them, and a hosted category has no membership tier.
    if (packageType !== 'onetime') return own;

    const doorways = all
      .filter(entry => entry.displayIn === category.id && entry.tierGroup)
      // A doorway whose every tier is unbookable right now would open onto an
      // empty screen.
      .filter(entry => (entry.packages || []).filter(pkg => !pkg.isMembership).some(bookableNow))
      .map(entry => ({
        kind: 'tierGroup',
        id: entry.tierGroup.id,
        categoryId: entry.id,
        tierGroup: entry.tierGroup,
        tierCount: (entry.packages || []).filter(pkg => !pkg.isMembership).filter(bookableNow).length
      }));

    return own.concat(doorways);
  }

  // The category a customer is conceptually inside, for highlighting step 1.
  function displayCategoryId(category) {
    if (!category) return null;
    return category.displayIn || category.id;
  }

  return Object.freeze({
    hasMembership,
    authorizedDates,
    scheduleUiState,
    selectedSlotIsAuthorized,
    cartCombination,
    cartLimitState,
    appendCartLine,
    serviceCards,
    displayCategoryId
  });
}));
