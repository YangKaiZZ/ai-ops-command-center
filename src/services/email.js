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

function getTransport() {
  if (!transport || transportUrl !== process.env.SMTP_URL) {
    transportUrl = process.env.SMTP_URL;
    transport = nodemailer.createTransport(transportUrl, { connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000 });
  }
  return transport;
}

async function sendEmail({ to, subject, text }) {
  if (!isEmailConfigured()) throw new Error('Email is not set up on this server (SMTP_URL, EMAIL_FROM)');
  await getTransport().sendMail({ from: process.env.EMAIL_FROM, to, subject, text });
}

module.exports = { isEmailConfigured, sendEmail };
