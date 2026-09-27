const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { getStoreCredentials, deleteSellerAccount } = require('../models/sellerModel');
const oauth = require('../services/shopifyOAuth');
const rateLimit = require('../services/rateLimit');

const { LIMITS } = rateLimit;

// DELETE /api/settings/account  { password }
// Deletes the seller's account and everything kept for it: orders, stock,
// decisions, alert settings, API keys. The app is uninstalled from their
// Shopify store first (best effort, like Disconnect). The password is asked
// again, and wrong ones count toward the sign-in limit, so a stolen session
// can't guess its way to deleting the account.
async function deleteAccount(req, res) {
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!password) return res.status(400).json({ error: 'Enter your password to delete your account' });
  try {
    const [[seller]] = await pool.query('SELECT email, password_hash FROM sellers WHERE id = ?', [req.sellerId]);
    if (!seller) return res.status(404).json({ error: 'Account not found' });

    const wait = await rateLimit.secondsUntilAllowed(LIMITS.loginFailuresPerAccount, seller.email);
    if (wait) return rateLimit.tooManyRequests(res, wait, 'Too many wrong passwords');
    if (!(await bcrypt.compare(password, seller.password_hash))) {
      await rateLimit.record(LIMITS.loginFailuresPerAccount, seller.email);
      return res.status(403).json({ error: 'That password is wrong' });
    }

    const creds = await getStoreCredentials(req.sellerId).catch(() => null);
    if (creds) {
      try {
        await oauth.revokeAccess(creds.shopDomain, creds.accessToken);
      } catch (err) {
        // Already uninstalled, or Shopify unreachable: delete here anyway.
        console.warn(`[account] seller ${req.sellerId}: uninstall from Shopify failed: ${err.response?.status || err.message}`);
      }
    }
    await deleteSellerAccount(req.sellerId);
    console.log(`[account] seller ${req.sellerId} deleted their account`);
    res.json({ deleted: true });
  } catch (err) {
    console.error(`[account] seller ${req.sellerId}:`, err);
    res.status(500).json({ error: 'Could not delete the account. Nothing was deleted; try again.' });
  }
}

module.exports = { deleteAccount };
