# AI Ops MCP server

An [MCP](https://modelcontextprotocol.io) server that exposes the backend's
REST API as tools, so an AI model can look at a seller's store and act on it:

| Tool | What it does |
| --- | --- |
| `get_pending_orders` | Orders that are unpaid or waiting to ship, oldest first (`limit`, `offset`) |
| `check_low_stock` | Items at or below their low-stock level |
| `get_all_orders` | Orders newest first, with the agent's verdict; filter by `status`, `financial_status`, `from`/`to` (UTC days); `limit`, `offset` |
| `get_order` | One order by number (`#1001`), with the agent's latest reasoning |
| `sync_latest_data` | Pulls the latest orders and stock from Shopify |

Order lists come back one page at a time (20 by default, at most 100) as
`{ total, returned, offset, next_offset, orders }`, so a big store doesn't
flood the model's context: `total` answers "how many" without reading every
order, and `next_offset` is where the next page starts (null on the last).

It's used in two places:
- **The backend's agent** starts it as a subprocess for each run, with a
  10-minute token for that one seller, and gets the four read-only tools.
  (`sync_latest_data` is left out on purpose: a sync can trigger the agent,
  so an agent that could sync could trigger itself.)
- **Claude Desktop**, so a seller can ask about their store in a chat.

It never touches the database. It only calls the REST API with the seller's
credentials, so every tool call is limited to that seller's data.

## Files
- `server.js` — the five tools
- `apiClient.js` — the HTTP client for the backend. Errors come back as
  messages the model can pass on ("the API key was revoked", "the backend
  isn't reachable").

## Use it from Claude Desktop
1. `npm install`
2. Copy `.env.example` to `.env`. Set `BACKEND_URL` to the backend, and
   create an API key in the dashboard (**Settings > API keys**) for
   `BACKEND_API_KEY`. The key is shown once and doesn't expire; revoke it on
   the same page. (A sign-in JWT in `BACKEND_JWT` also works, for 7 days.)
3. Add the server to Claude Desktop's config
   (`%APPDATA%\Claude\claude_desktop_config.json` on Windows):
   ```json
   {
     "mcpServers": {
       "ai-ops": {
         "command": "node",
         "args": ["C:\\path\\to\\ai-ops-command-center\\mcp\\server.js"]
       }
     }
   }
   ```
4. Restart Claude Desktop and ask something like "which orders need my
   attention?" or "what's running low?".
