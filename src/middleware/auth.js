const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/secrets');
const { isApiKey, findSellerIdByApiKey } = require('../models/apiKeyModel');

// This is what makes the whole app multi-tenant: every protected route
// runs through this first, and req.sellerId is used to scope every DB
// query so one seller can never see another seller's data.
//
// The bearer token is either a sign-in JWT (the dashboard) or an API key
// (aiops_..., for tools like the MCP server). req.authMethod says which.
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.split(' ')[1];

  if (isApiKey(token)) {
    try {
      const sellerId = await findSellerIdByApiKey(token);
      if (!sellerId) return res.status(401).json({ error: 'Invalid or revoked API key' });
      req.sellerId = sellerId;
      req.authMethod = 'api_key';
      return next();
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Could not check the API key' });
    }
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.sellerId = decoded.sellerId;
    req.authMethod = 'session';
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = requireAuth;
