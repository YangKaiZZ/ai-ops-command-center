const path = require('path');
const axios = require('axios');
// Resolve .env next to this file: Claude Desktop launches the server from its
// own working directory, not this folder. quiet: dotenv's log line would go to
// stdout and corrupt the MCP stdio protocol.
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

// This talks to the SAME backend you built in Phase 1/2 — the MCP layer
// doesn't touch your database directly, it just calls your REST API,
// exactly like curl did. That separation matters: it means your backend
// stays useful on its own (a future dashboard could call it too), and
// the MCP server is just one more client of it.
const api = axios.create({
  baseURL: process.env.BACKEND_URL || 'http://localhost:3000',
  headers: {
    Authorization: `Bearer ${process.env.BACKEND_JWT}`,
  },
});

module.exports = api;
