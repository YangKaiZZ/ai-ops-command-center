// Loose on purpose: something@something.tld, no spaces. Whether it really
// receives mail is checked by sending to it.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isEmail(value) {
  return typeof value === 'string' && value.length <= 255 && EMAIL_RE.test(value);
}

module.exports = { isEmail };
