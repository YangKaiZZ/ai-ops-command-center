const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.DASHBOARD_URL = 'https://dash.example.test';
const { summarizeRisk, mustHold, isFlagged, riskFromRow, describeRisk, riskForAgent, formatRiskAlert } = require('../src/services/riskCheck');
const { describeTrigger, enforceRiskCheck } = require('../src/services/agentService');

// An order as Shopify's GraphQL API returns it (shopifyService.fetchOrderRisks).
const node = (assessments, { recommendation = 'NONE', matches = true, ships = true } = {}) => ({
  id: 'gid://shopify/Order/1',
  requiresShipping: ships,
  billingAddressMatchesShippingAddress: matches,
  risk: { recommendation, assessments },
});
const fact = (description, sentiment = 'NEGATIVE') => ({ description, sentiment });

test('the worst finished assessment sets the level, with the facts that raised it', () => {
  const risk = summarizeRisk(
    node(
      [
        { riskLevel: 'LOW', facts: [fact('CVV matched', 'POSITIVE'), fact('Paid with a prepaid card')] },
        { riskLevel: 'HIGH', facts: [fact('Billing country differs from the IP'), fact('Paid with a prepaid card'), fact('Order is normal', 'NEUTRAL')] },
      ],
      { recommendation: 'CANCEL', matches: false }
    )
  );
  assert.deepEqual(risk, {
    level: 'high',
    recommendation: 'cancel',
    reasons: ['Paid with a prepaid card', 'Billing country differs from the IP'],
    billing_matches_shipping: false,
  });
});

test('pending while nothing worse than low is in; a finished high or medium stands', () => {
  assert.equal(summarizeRisk(node([{ riskLevel: 'PENDING', facts: [] }])).level, 'pending');
  assert.equal(summarizeRisk(node([{ riskLevel: 'LOW', facts: [] }, { riskLevel: 'PENDING', facts: [] }])).level, 'pending');
  assert.equal(summarizeRisk(node([{ riskLevel: 'MEDIUM', facts: [] }, { riskLevel: 'PENDING', facts: [] }])).level, 'medium');
});

test('no assessments is "none"; odd values fall back safely', () => {
  assert.deepEqual(summarizeRisk(node([])), { level: 'none', recommendation: 'none', reasons: [], billing_matches_shipping: true });
  assert.equal(summarizeRisk(node([{ riskLevel: 'NONE', facts: [] }])).level, 'none');
  assert.equal(summarizeRisk(node([{ riskLevel: 'SOMETHING_NEW', facts: [] }])).level, 'none');
  assert.equal(summarizeRisk(node([], { recommendation: 'SOMETHING_NEW' })).recommendation, 'none');
  assert.equal(summarizeRisk({ id: 'gid://shopify/Order/1', risk: null }).level, 'none');
});

test('nothing to ship: the address match is null', () => {
  assert.equal(summarizeRisk(node([], { ships: false, matches: false })).billing_matches_shipping, null);
});

test('at most 5 reasons, each at most 256 characters', () => {
  const facts = Array.from({ length: 8 }, (_, i) => fact(`${i} ${'x'.repeat(300)}`));
  const { reasons } = summarizeRisk(node([{ riskLevel: 'HIGH', facts }]));
  assert.equal(reasons.length, 5);
  assert.ok(reasons.every((r) => r.length === 256));
});

test('must hold: high risk or a cancel recommendation; flagged adds medium and investigate', () => {
  const risk = (level, recommendation = 'none') => ({ level, recommendation, reasons: [] });
  assert.equal(mustHold(risk('high')), true);
  assert.equal(mustHold(risk('low', 'cancel')), true);
  assert.equal(mustHold(risk('medium', 'investigate')), false);
  assert.equal(isFlagged(risk('medium')), true);
  assert.equal(isFlagged(risk('low', 'investigate')), true);
  assert.equal(isFlagged(risk('high')), true);
  for (const quiet of [risk('low', 'accept'), risk('none'), risk('pending'), risk('unknown'), null]) {
    assert.equal(isFlagged(quiet), false, JSON.stringify(quiet));
  }
});

test('a stored row becomes the API\'s risk, or null before it has been read', () => {
  assert.equal(riskFromRow({ risk_level: null, risk_checked_at: null }), null);
  const checkedAt = new Date('2026-09-26T02:00:00Z');
  const row = {
    risk_level: 'medium',
    risk_recommendation: 'investigate',
    risk_reasons: '["Many payment attempts"]', // JSON as text, or already parsed by the driver
    billing_matches_shipping: 0,
    risk_checked_at: checkedAt,
  };
  assert.deepEqual(riskFromRow(row), {
    level: 'medium',
    recommendation: 'investigate',
    reasons: ['Many payment attempts'],
    billing_matches_shipping: false,
    checked_at: checkedAt,
    flagged: true,
  });
  const redacted = riskFromRow({ ...row, risk_reasons: null, billing_matches_shipping: null, risk_level: 'low', risk_recommendation: 'accept' });
  assert.deepEqual([redacted.reasons, redacted.billing_matches_shipping, redacted.flagged], [[], null, false]);
});

test('described in words', () => {
  const r = (level, recommendation, reasons = []) => ({ level, recommendation, reasons });
  assert.equal(describeRisk(r('high', 'cancel', ['A', 'B'])), 'Shopify rates it high risk and recommends cancelling it (A; B)');
  assert.equal(describeRisk(r('none', 'investigate')), 'Shopify recommends checking it with the buyer');
  assert.equal(describeRisk(r('low', 'accept')), 'Shopify rates it low risk');
  assert.equal(describeRisk(r('none', 'none')), 'Shopify gave it no risk rating');
});

test('the agent reads the check, or why it is missing', () => {
  const risk = { level: 'high', recommendation: 'cancel', reasons: ['A'], billing_matches_shipping: false };
  assert.deepEqual(riskForAgent(risk), { risk_level: 'high', recommendation: 'cancel', reasons: ['A'], billing_matches_shipping: false });
  assert.deepEqual(riskForAgent({ level: 'unknown', error: 'the store is not connected' }), {
    risk_level: 'unknown',
    note: 'the store is not connected',
  });
});

const orderTrigger = { type: 'order_created', order: { id: 1, name: '#1001', financial_status: 'paid', total_price: '42.00' } };
const canShip = { canShip: true, short: [], lines: [] };

test('the order event carries the fraud check and says what it means for the verdict', () => {
  const high = { level: 'high', recommendation: 'cancel', reasons: ['A'], billing_matches_shipping: true };
  const event = describeTrigger(orderTrigger, canShip, null, high);
  assert.match(event, /Fraud check: Shopify rates it high risk and recommends cancelling it - verdict must be HOLD\./);
  assert.deepEqual(JSON.parse(event.slice(event.indexOf('{'))).fraud_check, {
    risk_level: 'high',
    recommendation: 'cancel',
    reasons: ['A'],
    billing_matches_shipping: true,
  });

  const medium = describeTrigger(orderTrigger, canShip, null, { level: 'medium', recommendation: 'none', reasons: [] });
  assert.match(medium, /Fraud check: Shopify rates it medium risk - HOLD for the seller to check, unless their notes say otherwise\./);
  assert.match(describeTrigger(orderTrigger, canShip, null, { level: 'pending', recommendation: 'none', reasons: [] }), /analysis hasn't finished/);
  assert.match(
    describeTrigger(orderTrigger, canShip, null, { level: 'unknown', reasons: [], error: 'the store is not connected' }),
    /Fraud check: couldn't be read \(the store is not connected\)\./
  );
  assert.match(describeTrigger(orderTrigger, canShip, null, { level: 'low', recommendation: 'accept', reasons: [] }), /Fraud check: Shopify rates it low risk\.\n/);
  assert.doesNotMatch(describeTrigger(orderTrigger, canShip), /Fraud check|fraud_check/);
});

test('high fraud risk overrides a FULFILL; anything else is left to the model', () => {
  const high = { level: 'high', recommendation: 'cancel', reasons: ['A'] };
  const result = enforceRiskCheck('FULFILL - looks fine\n- ships today', high);
  assert.equal(result.overridden, true);
  assert.match(result.reasoning, /^HOLD - fraud check: Shopify rates it high risk and recommends cancelling it \(A\)\n/);
  assert.match(result.reasoning, /FULFILL - looks fine/);
  assert.equal(enforceRiskCheck('HOLD - high fraud risk', high).overridden, false);
  assert.equal(enforceRiskCheck('FULFILL - ok', { level: 'medium', recommendation: 'investigate', reasons: [] }).overridden, false);
  assert.equal(enforceRiskCheck('FULFILL - ok', null).overridden, false);
});

test('the alert when risk went up after the agent decided', () => {
  const order = { id: 7, shopify_order_id: '555', order_number: '#1005', latest_verdict: 'fulfill' };
  const risk = { level: 'high', recommendation: 'cancel', reasons: ['Card declined 4 times'], billing_matches_shipping: false };
  assert.equal(
    formatRiskAlert(order, risk),
    [
      '*Fraud risk: order #1005*',
      'Shopify now rates it high risk and recommends cancelling it.',
      'The agent said FULFILL before this came in: hold it until you have checked it.',
      '- Card declined 4 times',
      "- The billing address doesn't match the shipping address (or one is missing)",
      'Review it: https://dash.example.test/orders/7',
    ].join('\n')
  );
  const held = formatRiskAlert({ ...order, latest_verdict: 'hold' }, { ...risk, billing_matches_shipping: true });
  assert.match(held, /already said HOLD for other reasons/);
  assert.doesNotMatch(held, /billing address/);
  assert.match(formatRiskAlert({ ...order, latest_verdict: 'skipped' }, risk), /The agent didn't check this order/);
});
