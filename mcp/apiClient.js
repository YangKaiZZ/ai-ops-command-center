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
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';

// An API key (aiops_...) from the dashboard's Settings page doesn't expire.
// BACKEND_JWT is the old way: a sign-in token that stops working after 7 days.
const token = process.env.BACKEND_API_KEY || process.env.BACKEND_JWT;

const api = axios.create({
  baseURL: BACKEND_URL,
  headers: token ? { Authorization: `Bearer ${token}` } : {},
  timeout: 60000,
});

// The tool's error text is what Claude shows the seller, so say what to do.
api.interceptors.response.use(null, (err) => {
  if (!token) {
    throw new Error('No API key set. Create one in the AI Ops dashboard (Settings > API keys) and put it in BACKEND_API_KEY in this MCP server\'s .env.');
  }
  if (err.response?.status === 401) {
    throw new Error('The AI Ops backend rejected the API key (revoked or mistyped). Create a new one in the dashboard (Settings > API keys) and put it in BACKEND_API_KEY in this MCP server\'s .env.');
  }
  if (!err.response) {
    throw new Error(`Could not reach the AI Ops backend at ${BACKEND_URL} (${err.code || err.message}). Is it running?`);
  }
  throw new Error(err.response.data?.error || `The AI Ops backend returned HTTP ${err.response.status}`);
});

module.exports = api;
