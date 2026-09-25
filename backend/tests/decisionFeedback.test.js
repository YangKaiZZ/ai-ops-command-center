const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const { parseFeedback } = require('../src/controllers/decisionsController');
const { countRatings } = require('../src/models/decisionModel');
const { describeFeedback } = require('../src/services/agentService');

test('feedback is up, down or null, with an optional note', () => {
  assert.deepEqual(parseFeedback({ feedback: 'up' }), { feedback: 'up', note: null });
  assert.deepEqual(parseFeedback({ feedback: 'down', note: '  Should have held: address mismatch  ' }), {
    feedback: 'down',
    note: 'Should have held: address mismatch',
  });
  assert.deepEqual(parseFeedback({ feedback: 'down', note: '   ' }), { feedback: 'down', note: null }); // blank is no note
  assert.deepEqual(parseFeedback({ feedback: 'up', note: null }), { feedback: 'up', note: null });
  assert.deepEqual(parseFeedback({ feedback: null, note: 'dropped' }), { feedback: null, note: null }); // clearing drops the note
});

test('anything else is refused', () => {
  for (const body of [{}, undefined, { feedback: 'UP' }, { feedback: 1 }, { feedback: true }, { feedback: '' }, { feedback: ['up'] }]) {
    assert.match(parseFeedback(body).error, /feedback must be "up", "down" or null/, JSON.stringify(body));
  }
  assert.match(parseFeedback({ feedback: 'down', note: 42 }).error, /note must be text/);
  assert.match(parseFeedback({ feedback: 'down', note: 'x'.repeat(501) }).error, /at most 500 characters/);
  assert.equal(parseFeedback({ feedback: 'down', note: ` ${'x'.repeat(500)} ` }).note.length, 500); // trimmed first
});

test('ratings are counted per verdict, skipped runs left out', () => {
  const ratings = countRatings([
    { action_taken: 'fulfill', n: 10, up: '6', down: '1' },
    { action_taken: 'hold', n: '3', up: null, down: '2' }, // SUM() of no rows is NULL
    { action_taken: 'skipped', n: 4, up: null, down: null },
    { action_taken: 'something-new', n: 1, up: 1, down: 0 },
  ]);
  assert.deepEqual(ratings, {
    up: 7,
    down: 3,
    unrated: 4,
    by_verdict: {
      fulfill: { up: 6, down: 1, unrated: 3 },
      hold: { up: 0, down: 2, unrated: 1 },
      low_stock_alert: { up: 0, down: 0, unrated: 0 },
      unknown: { up: 1, down: 0, unrated: 0 },
    },
  });
  assert.deepEqual(countRatings([]).by_verdict.fulfill, { up: 0, down: 0, unrated: 0 });
  assert.equal(countRatings([]).unrated, 0);
});

test('the agent gets the seller\'s ratings as data: its call, the rating and the note', () => {
  const text = describeFeedback([
    {
      order_number: '#1042',
      action_taken: 'hold',
      reasoning: 'HOLD - Payment still pending\n- Wait for the payment to clear',
      feedback: 'down',
      feedback_note: 'Bank transfers always show pending first; ship them.',
      created_at: new Date('2026-09-24T10:00:00Z'),
    },
    { order_number: null, action_taken: 'low_stock_alert', reasoning: `RESTOCK - ${'x'.repeat(300)}`, feedback: 'up', feedback_note: 'Good.', created_at: '2026-09-20T08:00:00.000Z' },
    { order_number: '#1001', action_taken: 'fulfill', reasoning: 'FULFILL - All in stock', feedback: 'down', feedback_note: null, created_at: '2026-09-19T08:00:00.000Z' },
  ]);
  const [intro, json] = [text.slice(0, text.indexOf('\n')), text.slice(text.indexOf('\n') + 1)];
  assert.match(intro, /seller's ratings of your recent calls/);
  const rated = JSON.parse(json);
  assert.deepEqual(rated[0], {
    decided_on: '2026-09-24',
    order: '#1042',
    your_call: 'HOLD - Payment still pending', // the first line only
    seller_says: 'wrong call',
    seller_note: 'Bank transfers always show pending first; ship them.',
  });
  assert.equal(rated[1].order, undefined); // low stock: no order
  assert.equal(rated[1].your_call.length, 200); // a long headline is cut
  assert.equal(rated[1].seller_says, 'right call');
  assert.equal('seller_note' in rated[2], false); // no note, no key
});

test('no ratings, no feedback text', () => {
  assert.equal(describeFeedback([]), null);
  assert.equal(describeFeedback(undefined), null);
});
