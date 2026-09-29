const nodemailer = require('nodemailer');

// Email alerts, sent through any SMTP provider:
//   SMTP_URL=smtps://user:password@smtp.example.com:465
//   EMAIL_FROM="AI Ops <alerts@example.com>"
// Without both, email isn't offered in Settings.

let transport = null;
let transportUrl = null;

function isEmailConfigured() {
  return Boolean(process.env.SMTP_URL && process.env.EMAIL_FROM);
}

const ADDRESS = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

// What's wrong with the two settings, in words, or null when they look
// right. Never repeats SMTP_URL itself: it holds the provider's password.
function emailSettingsProblem(smtpUrl = process.env.SMTP_URL, from = process.env.EMAIL_FROM) {
  if (!smtpUrl || !from) return null; // email is simply off
  let url = null;
  try {
    url = new URL(smtpUrl);
  } catch {
    // not a URL at all, e.g. only the password or API key
  }
  if (!url || !['smtp:', 'smtps:'].includes(url.protocol) || !url.hostname) {
    return 'SMTP_URL must be a whole address like smtps://user:password@smtp.example.com:465 (for Resend: smtps://resend:<API key>@smtp.resend.com:465)';
  }
  const address = from.match(/<([^<>]*)>\s*$/)?.[1] ?? from;
  if (!ADDRESS.test(address.trim())) {
    return `EMAIL_FROM needs a full address, like "AI Ops <alerts@example.com>" (it is ${JSON.stringify(from)})`;
  }
  return null;
}

function getTransport() {
  if (!transport || transportUrl !== process.env.SMTP_URL) {
    transportUrl = process.env.SMTP_URL;
    transport = nodemailer.createTransport(transportUrl, { connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000 });
  }
  return transport;
}

async function sendEmail({ to, subject, text }) {
  if (!isEmailConfigured()) throw new Error('Email is not set up on this server (SMTP_URL, EMAIL_FROM)');
  const problem = emailSettingsProblem();
  if (problem) throw new Error(problem);
  await getTransport().sendMail({ from: process.env.EMAIL_FROM, to, subject, text });
}

module.exports = { isEmailConfigured, emailSettingsProblem, sendEmail };
