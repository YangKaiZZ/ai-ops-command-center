const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const api = require('./apiClient');

const server = new McpServer({
  name: 'ai-ops-command-center',
  version: '1.0.0',
});

// --- Tool 1: get pending orders ---
// Claude calls this when the seller asks something like
// "what orders need my attention" or "what's still unshipped".
server.registerTool(
  'get_pending_orders',
  {
    title: 'Get Pending Orders',
    description:
      'Returns orders that are unpaid or awaiting shipment. Use this to answer questions about orders that need action.',
    inputSchema: {},
  },
  async () => {
    const { data } = await api.get('/api/orders/pending');
    return {
      content: [{ type: 'text', text: JSON.stringify(data.pending_orders, null, 2) }],
    };
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

// --- Tool 3: get all orders ---
// Slightly broader than get_pending_orders — useful for "how many orders
// today" or "show me recent sales" type questions.
server.registerTool(
  'get_all_orders',
  {
    title: 'Get All Orders',
    description:
      'Returns all synced orders for this seller, most recent first. Use this for general order history or sales summary questions.',
    inputSchema: {},
  },
  async () => {
    const { data } = await api.get('/api/orders');
    return {
      content: [{ type: 'text', text: JSON.stringify(data.orders, null, 2) }],
    };
  }
);

// --- Tool 4: trigger a fresh sync ---
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
