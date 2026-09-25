const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const api = require('./apiClient');

const server = new McpServer({
  name: 'ai-ops-command-center',
  version: '1.3.0',
});

const FULFILLMENT_STATUSES = ['unfulfilled', 'partial', 'fulfilled', 'restocked'];
const FINANCIAL_STATUSES = ['pending', 'authorized', 'partially_paid', 'paid', 'partially_refunded', 'refunded', 'voided', 'expired'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const limitInput = z.number().int().min(1).max(100).optional().describe('How many orders to return (default 20, at most 100)');
const offsetInput = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe('How many to skip, for the next page: pass next_offset from the previous result');

// One order, without what a model doesn't need. A list keeps only the verdict
// of the agent's latest decision and the fraud check's level; a single order
// keeps the reasoning and the fraud check's reasons too.
function slim(order, withReasoning) {
  const { synced_at, latest_decision, risk, ...rest } = order;
  if (risk !== undefined) {
    rest.risk = risk && !withReasoning ? { level: risk.level, recommendation: risk.recommendation, flagged: risk.flagged } : risk;
  }
  if (latest_decision === undefined) return rest;
  const decision = latest_decision && {
    verdict: latest_decision.action_taken,
    decided_at: latest_decision.created_at,
    ...(withReasoning ? { reasoning: latest_decision.reasoning } : {}),
  };
  return { ...rest, latest_decision: decision };
}

// A page as compact JSON, with the count and where the next page starts.
function pageText(orders, total, offset) {
  const end = offset + orders.length;
  return JSON.stringify({
    total,
    returned: orders.length,
    offset,
    next_offset: end < total ? end : null,
    orders: orders.map((o) => slim(o, false)),
  });
}

const query = (params) =>
  Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));

// --- Tool 1: get pending orders ---
// "What orders need my attention", "what's still unshipped".
server.registerTool(
  'get_pending_orders',
  {
    title: 'Get Pending Orders',
    description:
      'Returns orders that need action (unshipped, partly shipped or unpaid; not refunded or voided), oldest first, one page at a time. ' +
      '`total` is how many need action in all; when next_offset is not null there are more.',
    inputSchema: { limit: limitInput, offset: offsetInput },
  },
  async ({ limit = 20, offset = 0 }) => {
    const { data } = await api.get('/api/orders/pending', { params: query({ limit, offset }) });
    return { content: [{ type: 'text', text: pageText(data.pending_orders, data.total, offset) }] };
  }
);

// --- Tool 2: check low stock ---
server.registerTool(
  'check_low_stock',
  {
    title: 'Check Low Stock',
    description:
      'Returns inventory items at or below their low-stock threshold. Use this when asked about restocking or inventory levels.',
    inputSchema: {},
  },
  async () => {
    const { data } = await api.get('/api/inventory/low-stock');
    return {
      content: [{ type: 'text', text: JSON.stringify(data.low_stock_items, null, 2) }],
    };
  }
);

// --- Tool 3: search orders ---
// "How many orders this week", "show me unpaid orders from September".
server.registerTool(
  'get_all_orders',
  {
    title: 'Get Orders',
    description:
      'Returns synced orders, newest first, one page at a time, each with the verdict of the agent\'s latest decision ' +
      'and Shopify\'s fraud risk (level: high, medium, low, none or pending; null if not read yet). ' +
      'Filter by fulfillment status, payment status, date range (UTC days) and fraud risk. `total` counts every order that matches, ' +
      'so to answer "how many" use total with limit 1 instead of reading every order. When next_offset is not null there are more.',
    inputSchema: {
      limit: limitInput,
      offset: offsetInput,
      status: z.enum(FULFILLMENT_STATUSES).optional().describe('Only orders with this fulfillment status'),
      financial_status: z.enum(FINANCIAL_STATUSES).optional().describe('Only orders with this payment status'),
      from: z.string().regex(DATE, 'use YYYY-MM-DD').optional().describe('Only orders placed on or after this day, YYYY-MM-DD (UTC)'),
      to: z.string().regex(DATE, 'use YYYY-MM-DD').optional().describe('Only orders placed on or before this day, YYYY-MM-DD (UTC)'),
      flagged_only: z
        .boolean()
        .optional()
        .describe("Only orders Shopify's fraud check flagged: high or medium risk, or it advises cancelling or investigating"),
    },
  },
  async ({ limit = 20, offset = 0, status, financial_status, from, to, flagged_only }) => {
    const risk = flagged_only ? 'flagged' : undefined;
    const { data } = await api.get('/api/orders', { params: query({ limit, offset, status, financial_status, from, to, risk }) });
    return { content: [{ type: 'text', text: pageText(data.orders, data.total, offset) }] };
  }
);

// --- Tool 4: one order ---
// "What happened with order 1001?"
server.registerTool(
  'get_order',
  {
    title: 'Get Order',
    description:
      'Looks up one order by its number (e.g. "#1001"), with the agent\'s latest decision about it and the reasoning, ' +
      "and Shopify's fraud check: risk level, recommendation, the reasons, and whether the billing and shipping addresses match.",
    inputSchema: {
      order_number: z.string().min(1).max(50).describe('The order number, e.g. "#1001" or "1001"'),
    },
  },
  async ({ order_number }) => {
    const { data } = await api.get('/api/orders', { params: { number: order_number, limit: '5' } });
    if (!data.orders.length) {
      return {
        content: [
          {
            type: 'text',
            text: `No order ${order_number} is synced for this store. If it's new, sync_latest_data pulls the latest from Shopify.`,
          },
        ],
      };
    }
    const orders = data.orders.map((o) => slim(o, true));
    return { content: [{ type: 'text', text: JSON.stringify(orders.length === 1 ? orders[0] : orders) }] };
  }
);

// --- Tool 5: restock forecast ---
// "What should I reorder?", "when does the Mug run out?"
server.registerTool(
  'forecast_restock',
  {
    title: 'Forecast Restock',
    description:
      'Forecasts for tracked items, worked out from stored orders: units sold, sales per day, days of stock left, the date it runs out ' +
      '(runs_out_at) and how many to reorder so stock lasts cover_days. Soonest to run out first. `history` says what the forecasts ' +
      'are based on (days of orders, orders counted); always say that when you give a forecast, and call one with confidence "low" ' +
      'a rough estimate (few orders or a short history). By default only items that need a reorder are returned; pass `item` to look ' +
      'up items by name, or all_items for every item.',
    inputSchema: {
      item: z.string().min(1).max(100).optional().describe('Only items whose name contains this text (any case)'),
      all_items: z.boolean().optional().describe('Include items that need no reorder (default false; ignored with `item`)'),
      days: z.number().int().min(1).max(90).optional().describe('How many days of sales to base the pace on (default 30)'),
      cover_days: z.number().int().min(1).max(180).optional().describe('How many days a reorder should last (default 30)'),
      limit: z.number().int().min(1).max(100).optional().describe('How many items to return (default 25, at most 100)'),
    },
  },
  async ({ item, all_items = false, days, cover_days, limit = 25 }) => {
    const { data } = await api.get('/api/inventory/forecast', { params: query({ days, cover_days }) });
    const needle = item?.toLowerCase();
    const matching = data.items.filter((i) =>
      needle ? i.item_name.toLowerCase().includes(needle) : all_items || i.reorder_quantity > 0
    );
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            lookback_days: data.lookback_days,
            cover_days: data.cover_days,
            history: data.history,
            matching: matching.length,
            returned: Math.min(matching.length, limit),
            items: matching.slice(0, limit).map(({ id, ...rest }) => rest),
          }),
        },
      ],
    };
  }
);

// --- Tool 6: trigger a fresh sync ---
// Lets the seller say "refresh my data" or "pull the latest orders"
// and have Claude actually trigger the sync before answering.
server.registerTool(
  'sync_latest_data',
  {
    title: 'Sync Latest Shopify Data',
    description:
      'Pulls the latest orders and inventory from Shopify into the system. Use this when the seller wants fresh/updated data before you answer.',
    inputSchema: {},
  },
  async () => {
    const [orders, inventory] = await Promise.all([
      api.post('/api/orders/sync'),
      api.post('/api/inventory/sync'),
    ]);
    return {
      content: [
        {
          type: 'text',
          text: `${orders.data.message}. ${inventory.data.message}.`,
        },
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('AI Ops MCP server running on stdio'); // stderr so it doesn't corrupt the MCP stdout protocol
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
