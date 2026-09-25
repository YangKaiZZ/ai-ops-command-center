// Dates in a seller's own time zone (an IANA name such as "Asia/Manila"),
// with only the built-in Intl API. Used for the daily summary: when it's due
// and which hours "yesterday" covers.

const formatters = new Map();
function formatter(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(
      timeZone,
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    );
  }
  return formatters.get(timeZone);
}

// Whether Node knows this time zone name.
function isTimeZone(value) {
  if (typeof value !== 'string' || !value || value.length > 64) return false;
  try {
    formatter(value);
    return true;
  } catch {
    return false;
  }
}

// The wall-clock parts of an instant in a time zone: { year, month, day, hour, minute, second }.
function localParts(date, timeZone) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

const pad = (n) => String(n).padStart(2, '0');

// The local date of an instant, as YYYY-MM-DD.
function localDate(date, timeZone) {
  const p = localParts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

// A YYYY-MM-DD date moved by whole days.
function addDays(day, days) {
  const [y, m, d] = day.split('-').map(Number);
  const moved = new Date(Date.UTC(y, m - 1, d + days));
  return `${moved.getUTCFullYear()}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}`;
}

// How far the time zone is ahead of UTC at an instant, in ms.
function offsetMs(date, timeZone) {
  const p = localParts(date, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

// The instant a local day (YYYY-MM-DD) starts in a time zone. Checked twice,
// so it's right on days the clocks change.
function startOfDay(day, timeZone) {
  const [y, m, d] = day.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d);
  let guess = wall - offsetMs(new Date(wall), timeZone);
  guess = wall - offsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

module.exports = { isTimeZone, localParts, localDate, addDays, startOfDay };
