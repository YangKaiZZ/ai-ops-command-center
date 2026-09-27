// Run with: npm test  (Node strips the TypeScript types itself)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSend, replyParts, ordersSearchHref, toolsLine, questionsLeft, storageKey, MAX_SENT } from '../src/lib/chat.ts';

test('the question goes with the conversation so far, as role and text only', () => {
  const history = [
    { role: 'user', content: 'What ships today?' },
    { role: 'assistant', content: '#1001 and #1002.', tools: ['get_pending_orders'] },
  ];
  assert.deepEqual(toSend(history, 'And #1002?'), [
    { role: 'user', content: 'What ships today?' },
    { role: 'assistant', content: '#1001 and #1002.' },
    { role: 'user', content: 'And #1002?' },
  ]);
});

test('only the most recent messages are sent, starting with a question', () => {
  const history = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
  const sent = toSend(history, 'last');
  assert.ok(sent.length <= MAX_SENT);
  assert.equal(sent[0].role, 'user');
  assert.equal(sent.at(-1).content, 'last');
});

test('order numbers in a reply become links to the Orders page', () => {
  assert.deepEqual(replyParts('Ship #1001 first, then #1002.'), [
    { text: 'Ship ' },
    { text: '#1001', order: '#1001' },
    { text: ' first, then ' },
    { text: '#1002', order: '#1002' },
    { text: '.' },
  ]);
  assert.deepEqual(replyParts('No orders.'), [{ text: 'No orders.' }]);
  assert.deepEqual(replyParts('Item #1 is fine'), [{ text: 'Item #1 is fine' }]); // too short to be an order number
  assert.equal(ordersSearchHref('#1001'), '/orders?q=%231001');
});

test('what the answer looked at, in plain words', () => {
  assert.equal(toolsLine(['get_pending_orders', 'forecast_restock']), 'Looked at orders to ship, restock forecasts');
  assert.equal(toolsLine(['something_new']), 'Looked at something new');
  assert.equal(toolsLine([]), null);
  assert.equal(toolsLine(undefined), null);
});

test("today's questions left", () => {
  assert.equal(questionsLeft({ available: true, daily_limit: 40, used_today: 12 }), '28 of 40 questions left today');
  assert.equal(questionsLeft({ available: true, daily_limit: 5, used_today: 9 }), '0 of 5 questions left today');
  assert.equal(questionsLeft({ available: false, daily_limit: 40, used_today: 0 }), null);
  assert.equal(questionsLeft(null), null);
});

test("each account's conversation is kept under its own key", () => {
  const token = (payload) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
  assert.equal(storageKey(token({ sellerId: 7, iat: 1 })), 'aiops.chat.7');
  assert.notEqual(storageKey(token({ sellerId: 7 })), storageKey(token({ sellerId: 8 })));
  assert.equal(storageKey('not-a-token'), 'aiops.chat');
});
