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
4. Get a fresh JWT: log in via curl to your backend
   (`POST /api/auth/login`) and paste the token into `BACKEND_JWT` in `.env`.

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
