# AI Ops MCP Server (Phase 3)

This is the piece that makes the project unique. It exposes your Phase 1/2
REST API as **tools** Claude can call directly — so instead of a chatbot
that just talks, this lets Claude actually pull real data and take action.

## What's here
- `server.js` — defines 4 tools: get_pending_orders, check_low_stock,
  get_all_orders, sync_latest_data
- `apiClient.js` — calls your existing backend (the one from Phase 1/2)

## Setup
1. Make sure your Phase 1/2 backend is running (`npm run dev` in that project).
2. `npm install` here.
3. Copy `.env.example` to `.env`.
4. Create an API key: in the AI Ops dashboard go to **Settings > API keys**,
   name it (e.g. "Claude Desktop") and copy the key into `BACKEND_API_KEY`
   in `.env`. It's shown only once. It doesn't expire; if it leaks, revoke it
   on the same page and create a new one.

   (The old way, a sign-in JWT in `BACKEND_JWT`, still works but stops working
   after 7 days. If both are set, `BACKEND_API_KEY` wins.)

If a tool fails, Claude shows why: a revoked key, or the backend not running.

## Connect it to Claude Desktop
Add this to your Claude Desktop config file
(`%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "ai-ops": {
      "command": "node",
      "args": ["C:\\full\\path\\to\\ai-ops-mcp\\server.js"]
    }
  }
}
```

Restart Claude Desktop completely. You should see a small tools/plug icon
in the chat — that means it found your MCP server. Then just ask Claude
things like "what orders need my attention" or "check my low stock items"
and it'll call your tools and answer with real data from your Shopify store.

## This is your demo
Once this works, record a short screen capture: ask Claude a question,
show it calling the tool, show the real answer coming back. That video +
the GitHub repo IS your portfolio piece.
