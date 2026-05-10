const TEXTIFY_BASE = 'https://portal.textify.africa/api';

/**
 * E.164 for SMS (default TZ 255). Strips non-digits; leading 0 -> 255…; 9 digits -> prefix country.
 */
function normalizePhoneE164(raw, countryCode = process.env.SMS_DEFAULT_COUNTRY_CODE || '255') {
  if (raw == null) return null;
  let d = String(raw).replace(/\D/g, '');
  if (!d) return null;
  const cc = String(countryCode).replace(/\D/g, '') || '255';
  if (d.startsWith('0')) d = cc + d.slice(1);
  else if (d.length === 9) d = cc + d;
  if (d.length < 10 || d.length > 15) return null;
  return d;
}

/**
 * @returns {{ ok: boolean, messageId?: string, error?: string, raw?: object }}
 */
async function sendSms({ receiver, content }) {
  const key = process.env.TEXTIFY_API_KEY;
  const sender = process.env.TEXTIFY_SENDER_NAME;
  if (!key || !sender) {
    return { ok: false, error: 'TEXTIFY_API_KEY or TEXTIFY_SENDER_NAME not configured' };
  }
  const phone = typeof receiver === 'string' ? receiver.replace(/\D/g, '') : '';
  if (!phone) return { ok: false, error: 'Invalid receiver' };

  try {
    const res = await fetch(`${TEXTIFY_BASE}/message/create`, {
      method: 'POST',
      headers: {
        Authorization: key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sender_name: sender,
        messages: [{ receiver: phone, content: String(content).slice(0, 2000) }],
        is_scheduled: false,
        scheduled_date: null,
      }),
    });
    const raw = await res.json().catch(() => ({}));
    if (!res.ok || raw.success === false) {
      const msg = raw.message || raw.error || res.statusText || 'Textify request failed';
      return { ok: false, error: typeof msg === 'string' ? msg : JSON.stringify(msg), raw };
    }
    const arr = raw.message;
    const first = Array.isArray(arr) && arr.length ? arr[0] : null;
    const messageId = first && first.id ? String(first.id) : null;
    return { ok: true, messageId, raw };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

module.exports = {
  normalizePhoneE164,
  sendSms,
};
