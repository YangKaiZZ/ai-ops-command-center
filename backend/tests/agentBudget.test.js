const test = require('node:test');
const assert = require('node:assert/strict');

const { limits, overLimit, readLimit, skippedReasoning, DEFAULTS } = require('../src/services/agentBudget');
const { actionFromReasoning } = require('../src/models/decisionModel');

test('a limit reads as a whole number; blank or invalid means the default, 0 means off', () => {
  const name = 'AGENT_TEST_LIMIT';
  for (const [raw, expected] of [
    [undefined, 7],
    ['', 7],
    ['  ', 7],
    ['25', 25],
    ['0', 0],
    ['-1', 7],
    ['2.5', 7],
    ['lots', 7],
  ]) {
    if (raw === undefined) delete process.env[name];
    else process.env[name] = raw;
    assert.equal(readLimit(name, 7), expected, `"${raw}"`);
  }
  delete process.env[name];
});

test('defaults apply when nothing is set', () => {
  delete process.env.AGENT_DAILY_LIMIT_PER_ACCOUNT;
  delete process.env.AGENT_DAILY_LIMIT_TOTAL;
  assert.deepEqual(limits(), DEFAULTS);
});

test('a run goes ahead only while both the account and the total are under their caps', () => {
  const caps = { perAccount: 3, total: 10 };
  assert.equal(overLimit({ accountRuns: 0, totalRuns: 0 }, caps), null);
  assert.equal(overLimit({ accountRuns: 2, totalRuns: 9 }, caps), null);
  assert.equal(overLimit({ accountRuns: 3, totalRuns: 3 }, caps), 'account');
  assert.equal(overLimit({ accountRuns: 1, totalRuns: 10 }, caps), 'total');
  assert.equal(overLimit({ accountRuns: 0, totalRuns: 0 }, { perAccount: 0, total: 10 }), 'account'); // 0 = off
});

test('a skipped run is saved as its own verdict, naming what was skipped', () => {
  const order = { type: 'order_created', order: { name: '#1001' } };
  const lowStock = { type: 'low_stock_crossed', items: [] };

  const account = skippedReasoning('account', order, { perAccount: 50 });
  assert.equal(actionFromReasoning(account), 'skipped');
  assert.match(account, /order #1001/);
  assert.match(account, /its 50 agent checks/);

  const total = skippedReasoning('total', lowStock, { perAccount: 50 });
  assert.equal(actionFromReasoning(total), 'skipped');
  assert.match(total, /low-stock change/);
});

test("the model's own verdicts still parse as before", () => {
  assert.equal(actionFromReasoning('FULFILL - all in stock'), 'fulfill');
  assert.equal(actionFromReasoning('HOLD - 2 short'), 'hold');
  assert.equal(actionFromReasoning('RESTOCK - mugs'), 'low_stock_alert');
  assert.equal(actionFromReasoning('Not sure'), 'unknown');
});
