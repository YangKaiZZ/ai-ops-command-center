// Run with: npm test  (Node strips the TypeScript types itself)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { riskBadge, riskWorthShowing, riskSummary, addressMatchText } from '../src/lib/format.ts';

const risk = (level, recommendation = 'none', extra = {}) => ({
  level,
  recommendation,
  reasons: [],
  billing_matches_shipping: true,
  checked_at: '2026-09-26T02:00:00.000Z',
  flagged: ['high', 'medium'].includes(level) || ['cancel', 'investigate'].includes(recommendation),
  ...extra,
});

test('the badge shows the worst signal: high or cancel, then medium or investigate', () => {
  const label = (r) => `${riskBadge(r).label}/${riskBadge(r).tone}`;
  assert.equal(label(risk('high', 'investigate')), 'High risk/critical');
  assert.equal(label(risk('low', 'cancel')), 'Cancel advised/critical');
  assert.equal(label(risk('medium', 'accept')), 'Medium risk/serious');
  assert.equal(label(risk('low', 'investigate')), 'Check advised/serious');
  assert.equal(label(risk('pending')), 'Risk pending/neutral');
  assert.equal(label(risk('low', 'accept')), 'Low risk/good');
  assert.equal(label(risk('none')), 'Not rated/neutral');
});

test('a list only badges flagged orders and ones still being checked', () => {
  assert.equal(riskWorthShowing(risk('high')), true);
  assert.equal(riskWorthShowing(risk('low', 'investigate')), true);
  assert.equal(riskWorthShowing(risk('pending')), true);
  assert.equal(riskWorthShowing(risk('low', 'accept')), false);
  assert.equal(riskWorthShowing(risk('none')), false);
  assert.equal(riskWorthShowing(null), false);
});

test("what Shopify says, in a sentence", () => {
  assert.equal(riskSummary(risk('high', 'cancel')), 'Shopify rates it high risk and recommends cancelling it.');
  assert.equal(riskSummary(risk('low', 'accept')), 'Shopify rates it low risk and recommends fulfilling it.');
  assert.equal(riskSummary(risk('none', 'investigate')), 'Shopify recommends checking it with the buyer.');
  assert.equal(riskSummary(risk('medium')), 'Shopify rates it medium risk.');
  assert.equal(riskSummary(risk('none')), 'Shopify gave it no risk rating.');
  assert.equal(riskSummary(risk('pending')), "Shopify's fraud analysis hasn't finished yet.");
});

test('the address check in words', () => {
  assert.match(addressMatchText(true), /matches/);
  assert.match(addressMatchText(false), /doesn't match the shipping address \(or one is missing\)/);
  assert.match(addressMatchText(null), /Nothing in this order ships/);
});
