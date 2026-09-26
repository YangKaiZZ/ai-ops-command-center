const orderModel = require('../models/orderModel');
const sellerModel = require('../models/sellerModel');
const shopifyService = require('./shopifyService');
const { postDecision } = require('./notifier');
const { dashboardUrl } = require('./ratingLinks');
const { autoHold } = require('./orderActions');

// Shopify's fraud analysis of an order, read in code like the stock check
// (stockCheck.js) so the agent gets it as facts, and kept on the order for
// the dashboard. Shopify rates every order, and fraud apps the store uses can
// add assessments of their own; the worst one counts.
//
// Assessments can come in after the order (Shopify's own takes seconds, an
// app's can take longer), so:
//   - an order's agent run waits a few minutes for a pending one (agentService.js)
//   - each order sync reads it again for open orders from the last week, and
//     if it went up after the agent had decided, tells the seller (refreshRecentRisks)

const LEVEL_RANK = { none: 0, low: 1, medium: 2, high: 3 };
const RECOMMENDATIONS = ['accept', 'investigate', 'cancel', 'none'];
const ADVICE = { cancel: 'recommends cancelling it', investigate: 'recommends checking it with the buyer' };
const MAX_REASONS = 5;
const RECHECK_DAYS = 7;
const RECHECK_LIMIT = 250; // orders per sync

// Orders worth a look before shipping (isFlagged), in SQL.
const FLAGGED_WHERE = "(risk_level IN ('high', 'medium') OR risk_recommendation IN ('cancel', 'investigate'))";

// Our summary of one order from shopifyService.fetchOrderRisks():
//   level: the worst finished assessment (high, medium, low); none when
//          nothing rated it; pending while one is still running and nothing
//          worse than low is in yet
//   recommendation: Shopify's advice (accept, investigate, cancel, none)
//   reasons: the facts that raised the risk, as the assessments word them
//   billing_matches_shipping: false also when an address is missing (that's
//          how Shopify reports it); null when nothing in the order ships
function summarizeRisk(node) {
  let level = 'none';
  let pending = false;
  const reasons = [];
  for (const assessment of node?.risk?.assessments || []) {
    const assessed = String(assessment.riskLevel || '').toLowerCase();
    if (assessed === 'pending') {
      pending = true;
      continue;
    }
    if (LEVEL_RANK[assessed] > LEVEL_RANK[level]) level = assessed;
    for (const fact of assessment.facts || []) {
      const text = String(fact.description || '').trim().slice(0, 256);
      if (fact.sentiment === 'NEGATIVE' && text && !reasons.includes(text)) reasons.push(text);
    }
  }
  // A finished high or medium stands; anything milder may still change.
  if (pending && LEVEL_RANK[level] < LEVEL_RANK.medium) level = 'pending';
  const recommendation = String(node?.risk?.recommendation || '').toLowerCase();
  return {
    level,
    recommendation: RECOMMENDATIONS.includes(recommendation) ? recommendation : 'none',
    reasons: reasons.slice(0, MAX_REASONS),
    billing_matches_shipping: node?.requiresShipping === false ? null : (node?.billingAddressMatchesShippingAddress ?? null),
  };
}

// High risk, or Shopify advises cancelling: the verdict is HOLD, and the
// model can't change that (agentService.enforceRiskCheck).
function mustHold(risk) {
  return Boolean(risk) && (risk.level === 'high' || risk.recommendation === 'cancel');
}

// Worth the seller's look before shipping: mustHold, medium risk, or Shopify
// advises investigating.
function isFlagged(risk) {
  return mustHold(risk) || (Boolean(risk) && (risk.level === 'medium' || risk.recommendation === 'investigate'));
}

// The stored analysis on an order row (orderModel.RISK_COLUMNS), or null if
// it hasn't been read yet.
function riskFromRow(row) {
  if (!row?.risk_checked_at) return null;
  const reasons = typeof row.risk_reasons === 'string' ? JSON.parse(row.risk_reasons) : row.risk_reasons;
  const risk = {
    level: row.risk_level,
    recommendation: row.risk_recommendation,
    reasons: Array.isArray(reasons) ? reasons : [],
    billing_matches_shipping: row.billing_matches_shipping == null ? null : Boolean(row.billing_matches_shipping),
    checked_at: row.risk_checked_at,
  };
  return { ...risk, flagged: isFlagged(risk) };
}

// What Shopify says, after "Shopify": "rates it high risk and recommends
// cancelling it", "recommends checking it with the buyer", "gave it no risk rating".
function riskPhrase(risk) {
  const rated = LEVEL_RANK[risk.level] > 0 ? `rates it ${risk.level} risk` : null;
  const advice = ADVICE[risk.recommendation];
  if (rated && advice) return `${rated} and ${advice}`;
  return rated || advice || 'gave it no risk rating';
}

// "Shopify rates it high risk and recommends cancelling it (reason; reason)"
function describeRisk(risk) {
  const text = `Shopify ${riskPhrase(risk)}`;
  return risk.reasons?.length ? `${text} (${risk.reasons.join('; ')})` : text;
}

// The analysis as the agent reads it (the fraud_check in its event).
function riskForAgent(risk) {
  if (risk.error) return { risk_level: 'unknown', note: risk.error };
  return {
    risk_level: risk.level,
    recommendation: risk.recommendation,
    reasons: risk.reasons,
    billing_matches_shipping: risk.billing_matches_shipping,
  };
}

const unknownRisk = (error) => ({ level: 'unknown', recommendation: 'none', reasons: [], billing_matches_shipping: null, error });

// One order's analysis straight from Shopify, saved on the order. Never
// throws: when Shopify can't be asked it returns level "unknown" with the
// reason in `error`, and the agent decides without it (and says so).
async function checkOrderRisk(sellerId, shopifyOrderId) {
  const id = String(shopifyOrderId);
  let risk;
  try {
    const creds = await sellerModel.getStoreCredentials(sellerId);
    if (!creds) return unknownRisk('the store is not connected');
    const node = (await shopifyService.fetchOrderRisks(creds.shopDomain, creds.accessToken, [id])).get(id);
    if (!node) return unknownRisk('Shopify did not return this order');
    risk = summarizeRisk(node);
  } catch (err) {
    console.warn(`[risk seller=${sellerId}] order ${id}: ${err.response?.status || err.message}`);
    return unknownRisk("Shopify's fraud analysis couldn't be read");
  }
  try {
    await orderModel.saveRisk(sellerId, id, risk);
  } catch (err) {
    console.error(`[risk seller=${sellerId}] could not save order ${id}'s risk: ${err.message}`);
  }
  return risk;
}

// What the agent had said about the order, for the alert.
const VERDICT_NOTE = {
  fulfill: 'The agent said FULFILL before this came in: hold it until you have checked it.',
  hold: 'The agent already said HOLD for other reasons: check this too before you ship it.',
};

// The alert for an order whose risk went up after the agent decided, with
// how auto-hold went when it held the order (orderActions.autoHold).
function formatRiskAlert(order, risk, holdLine = null) {
  const lines = [
    `*Fraud risk: order ${order.order_number ?? order.shopify_order_id}*`,
    `Shopify now ${riskPhrase(risk)}.`,
    VERDICT_NOTE[order.latest_verdict] || "The agent didn't check this order: check it before you ship it.",
    ...risk.reasons.map((reason) => `- ${reason}`),
  ];
  if (risk.billing_matches_shipping === false) lines.push("- The billing address doesn't match the shipping address (or one is missing)");
  if (holdLine) lines.push(holdLine);
  lines.push(`Review it: ${dashboardUrl()}/orders/${order.id}`);
  return lines.join('\n');
}

// Reads the analysis again for open orders from the last week and saves it.
// When an order's risk went up to flagged after the agent had decided on it,
// the seller gets an alert, once per order. (An order the agent hasn't run on
// yet needs none: its run reads the risk itself.) Returns { checked, alerted }.
async function refreshRecentRisks(sellerId, creds) {
  const rows = await orderModel.openOrdersForRiskCheck(sellerId, RECHECK_DAYS, RECHECK_LIMIT);
  if (!rows.length) return { checked: 0, alerted: 0 };
  const nodes = await shopifyService.fetchOrderRisks(
    creds.shopDomain,
    creds.accessToken,
    rows.map((row) => String(row.shopify_order_id))
  );

  let checked = 0;
  let alerted = 0;
  for (const row of rows) {
    const node = nodes.get(String(row.shopify_order_id));
    if (!node) continue;
    const risk = summarizeRisk(node);
    await orderModel.saveRisk(sellerId, row.shopify_order_id, risk);
    checked++;
    if (row.latest_verdict && !row.risk_alerted_at && isFlagged(risk) && !isFlagged(riskFromRow(row))) {
      // High risk (or "cancel") is a HOLD the agent would have made: with
      // auto-hold on, it's put on hold in Shopify too.
      const holdLine = mustHold(risk)
        ? await autoHold(sellerId, row.shopify_order_id, { reason: 'HIGH_RISK_OF_FRAUD', note: describeRisk(risk).slice(0, 255) })
        : null;
      await postDecision(sellerId, formatRiskAlert(row, risk, holdLine));
      await orderModel.markRiskAlerted(row.id);
      alerted++;
    }
  }
  return { checked, alerted };
}

module.exports = {
  summarizeRisk,
  mustHold,
  isFlagged,
  riskFromRow,
  describeRisk,
  riskForAgent,
  checkOrderRisk,
  formatRiskAlert,
  refreshRecentRisks,
  FLAGGED_WHERE,
  RECHECK_DAYS,
};
