const reports = require('../models/reportModel');
const { sendDailySummary } = require('../services/reports');
const { isTimeZone, localParts, localDate } = require('../utils/timeZone');

// Settings for the daily summary and late-order alerts (services/reports.js),
// under /api/settings for signed-in sellers.

const LATE_AFTER_HOURS = [12, 24, 48, 72];

// The settings as the dashboard sees them. timezone is null until saved once
// (the summary then runs on UTC).
function reportSettings(row) {
  return {
    timezone: row.timezone || null,
    summary: { enabled: Boolean(row.summary_enabled), hour: row.summary_hour },
    late_orders: { enabled: Boolean(row.late_alerts_enabled), after_hours: row.late_after_hours },
  };
}

// Body: { timezone, summary: { enabled, hour }, late_orders: { enabled, after_hours } }.
// Returns { timezone, summary, lateOrders } or { error }.
function parseReportSettings(body) {
  const { timezone, summary, late_orders: late } = body || {};
  if (!isTimeZone(timezone)) return { error: 'Choose a time zone, e.g. Asia/Manila' };
  if (typeof summary?.enabled !== 'boolean' || !Number.isInteger(summary.hour) || summary.hour < 0 || summary.hour > 23) {
    return { error: 'summary needs enabled (true or false) and an hour from 0 to 23' };
  }
  if (typeof late?.enabled !== 'boolean' || !LATE_AFTER_HOURS.includes(late.after_hours)) {
    return { error: `late_orders needs enabled (true or false) and after_hours: ${LATE_AFTER_HOURS.join(', ')}` };
  }
  return { timezone, summary: { enabled: summary.enabled, hour: summary.hour }, lateOrders: { enabled: late.enabled, afterHours: late.after_hours } };
}

// PUT /api/settings/reports
// Turning the summary on after today's hour has passed starts it tomorrow,
// instead of sending one at once ("Send one now" is there for that).
async function saveReports(req, res) {
  const parsed = parseReportSettings(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const now = new Date();
  const sentOn =
    parsed.summary.enabled && localParts(now, parsed.timezone).hour >= parsed.summary.hour ? localDate(now, parsed.timezone) : null;
  try {
    await reports.saveReportSettings(req.sellerId, parsed, sentOn);
    res.json({ reports: reportSettings(await reports.getReportSettings(req.sellerId)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save the report settings' });
  }
}

// POST /api/settings/reports/summary
// Sends today's summary now, as a preview: the scheduled one still comes.
async function sendSummaryNow(req, res) {
  try {
    const results = await sendDailySummary(req.sellerId, { preview: true });
    if (!results.length) return res.status(400).json({ error: 'Turn on at least one alert channel first.' });
    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not send the summary' });
  }
}

module.exports = { reportSettings, parseReportSettings, saveReports, sendSummaryNow, LATE_AFTER_HOURS };
