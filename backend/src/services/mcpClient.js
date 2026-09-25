const jwt = require('jsonwebtoken');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport, getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { JWT_SECRET } = require('../config/secrets');

// The agent only gets read-only tools. sync_latest_data is left out on
// purpose: an inventory sync can itself trigger the agent, so letting the
// agent sync would be a trigger -> sync -> trigger loop.
const AGENT_TOOLS = ['get_pending_orders', 'check_low_stock', 'get_all_orders', 'get_order', 'forecast_restock'];

// Spawns the Phase 3 MCP server as a subprocess and connects to it — the
// agent uses the exact same tools Claude Desktop does. The server is handed a
// short-lived JWT for this seller, so every tool call stays tenant-scoped
// (and doesn't depend on whatever token is sitting in the MCP server's .env).
async function connectAsSeller(sellerId) {
  const serverPath = process.env.MCP_SERVER_PATH;
  if (!serverPath) throw new Error('MCP_SERVER_PATH is not set in .env');

  const token = jwt.sign({ sellerId }, JWT_SECRET, { expiresIn: '10m' });
  const transport = new StdioClientTransport({
    command: process.execPath, // same node binary that's running the backend
    args: [serverPath],
    env: {
      ...getDefaultEnvironment(),
      BACKEND_URL: `http://localhost:${process.env.PORT || 3000}`,
      // The MCP server sends BACKEND_API_KEY as its bearer token; the backend
      // accepts a JWT there too. Real env vars win over the MCP server's .env,
      // so a key in that file (the Claude Desktop seller's) can't leak in.
      BACKEND_API_KEY: token,
    },
    stderr: 'ignore',
  });

  const client = new Client({ name: 'ai-ops-agent', version: '1.0.0' });
  await client.connect(transport);

  const { tools } = await client.listTools();
  const allowed = tools.filter((t) => AGENT_TOOLS.includes(t.name));

  return {
    tools: allowed,

    async callTool(name, args = {}) {
      if (!AGENT_TOOLS.includes(name)) {
        return { isError: true, text: `Tool "${name}" is not available to the agent` };
      }
      const result = await client.callTool({ name, arguments: args });
      const text = result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      return { isError: Boolean(result.isError), text };
    },

    close: () => client.close(),
  };
}

module.exports = { connectAsSeller, AGENT_TOOLS };
