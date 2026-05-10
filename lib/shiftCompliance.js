/**
 * Mirrors shift compliance rules in server.js (compliance / with_shift SQL).
 * Compares clock times only (HH:MM:SS), same as PostgreSQL ::TIME comparisons.
 */

function normalizeTimeString(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    const m = v.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return null;
    const h = String(parseInt(m[1], 10)).padStart(2, '0');
    const min = String(parseInt(m[2], 10)).padStart(2, '0');
    const sec = String(parseInt(m[3] || '0', 10)).padStart(2, '0');
    return `${h}:${min}:${sec}`;
  }
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const p = (n) => String(n).padStart(2, '0');
    return `${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}`;
  }
  return null;
}

function timeToSec(clock) {
  if (!clock) return null;
  const parts = clock.split(':').map((x) => parseInt(x, 10));
  if (parts.length < 2 || parts.some((n) => Number.isNaN(n))) return null;
  return parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
}

function cmpClock(a, b) {
  const sa = normalizeTimeString(a);
  const sb = normalizeTimeString(b);
  if (!sa || !sb) return null;
  return timeToSec(sa) - timeToSec(sb);
}

/**
 * @param {object} opts
 * @param {string|null} opts.firstScanClock - 'HH24:MI:SS'
 * @param {string|null} opts.lastScanClock
 * @param {number} opts.totalScans
 * @param {object|null} opts.shift - shift_config row with checkin_end, checkout_start, checkout_end
 */
function evaluateShiftCompliance({ firstScanClock, lastScanClock, totalScans, shift }) {
  if (!shift || totalScans < 1) {
    return { checkinOnTime: false, checkoutOnTime: false, eligibleForPayment: false };
  }

  const checkinEnd = normalizeTimeString(shift.checkin_end);
  const checkoutStart = normalizeTimeString(shift.checkout_start);
  const checkoutEnd = normalizeTimeString(shift.checkout_end);

  const first = normalizeTimeString(firstScanClock);
  const last = normalizeTimeString(lastScanClock);

  let checkinOnTime = false;
  if (first && checkinEnd != null) {
    const c = cmpClock(first, checkinEnd);
    checkinOnTime = c !== null && c <= 0;
  }

  let checkoutOnTime = false;
  if (totalScans > 1 && last && checkoutStart != null && checkoutEnd != null) {
    const geStart = cmpClock(last, checkoutStart);
    const leEnd = cmpClock(last, checkoutEnd);
    checkoutOnTime = geStart !== null && leEnd !== null && geStart >= 0 && leEnd <= 0;
  }

  return {
    checkinOnTime,
    checkoutOnTime,
    eligibleForPayment: checkinOnTime && checkoutOnTime && totalScans > 1,
  };
}

module.exports = {
  normalizeTimeString,
  evaluateShiftCompliance,
};
