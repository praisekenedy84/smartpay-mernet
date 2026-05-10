require('dotenv').config();
const { randomUUID } = require('crypto');
const { Pool } = require('pg');
const { evaluateShiftCompliance } = require('./lib/shiftCompliance');
const { normalizePhoneE164, sendSms } = require('./lib/textify');
const { renderEligibilitySms } = require('./lib/smsTemplate');
const { ensureSmartpayExtendedTables } = require('./lib/schemaSmartpay');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const POLL_INTERVAL_MS = 30 * 100;
const SETTING_KEY_DEFAULT_SHIFT = 'default_shift_id';
const SETTING_SMS_TEMPLATE = 'sms_eligibility_template';

let shiftCache = null;
let shiftCachedAt = 0;
let shiftCacheForId = null;

async function ensureSettings(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS smartpay_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  await client.query(
    `INSERT INTO smartpay_settings (key, value) VALUES ($1, '1')
     ON CONFLICT (key) DO NOTHING`,
    [SETTING_KEY_DEFAULT_SHIFT]
  );
  await client.query(
    `INSERT INTO smartpay_settings (key, value) VALUES ($1, '')
     ON CONFLICT (key) DO NOTHING`,
    [SETTING_SMS_TEMPLATE]
  );
}

async function getDefaultShiftId(client) {
  await ensureSettings(client);
  const r = await client.query(
    `SELECT COALESCE(NULLIF(TRIM(value), '')::int, 1) AS id
     FROM smartpay_settings WHERE key = $1 LIMIT 1`,
    [SETTING_KEY_DEFAULT_SHIFT]
  );
  const id = r.rows[0] && r.rows[0].id;
  return typeof id === 'number' && !Number.isNaN(id) ? id : 1;
}

async function getSmsTemplate(client) {
  const r = await client.query('SELECT value FROM smartpay_settings WHERE key = $1 LIMIT 1', [
    SETTING_SMS_TEMPLATE,
  ]);
  const v = r.rows[0] && r.rows[0].value;
  return v && String(v).trim() ? String(v).trim() : null;
}

async function loadEmployeeShiftMap(client) {
  const r = await client.query('SELECT id, shift_id FROM employeex');
  const map = new Map();
  for (const row of r.rows) {
    map.set(String(row.id).trim(), row.shift_id);
  }
  return map;
}

async function getShift(client, shiftId) {
  const now = Date.now();
  if (shiftCache && shiftCacheForId === shiftId && now - shiftCachedAt < 60000) return shiftCache;
  const r = await client.query('SELECT * FROM shift_config WHERE id = $1 AND active = TRUE', [shiftId]);
  if (!r.rows.length) {
    return null;
  }
  shiftCache = r.rows[0];
  shiftCachedAt = now;
  shiftCacheForId = shiftId;
  console.log(
    `  📋 Default shift: ${shiftCache.shift_name} | in ${shiftCache.checkin_start}-${shiftCache.checkin_end} | out ${shiftCache.checkout_start}-${shiftCache.checkout_end}`
  );
  return shiftCache;
}

async function loadShiftMap(client, shiftIds) {
  const ids = [...shiftIds]
    .map((x) => Number(x))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return new Map();
  const r = await client.query(
    'SELECT * FROM shift_config WHERE active = TRUE AND id = ANY($1::int[])',
    [ids]
  );
  return new Map(r.rows.map((row) => [row.id, row]));
}

async function processRow(client, row, employeeShiftMap, defaultShiftId) {
  const eventTime = new Date(row.authdatetime);
  if (isNaN(eventTime.getTime())) {
    console.warn(`  ⚠ Invalid datetime for employeeid=${row.employeeid}: "${row.authdatetime}" — skipping`);
    return;
  }

  const empKey = row.employeeid != null ? String(row.employeeid).trim() : '';
  const override = employeeShiftMap.get(empKey);
  const resolvedShiftId = override != null && override !== '' ? override : defaultShiftId;

  await client.query(
    `
    INSERT INTO attendance_log
      (employee_id, card_no, raw_event_time, direction, event_type, shift_id)
    VALUES ($1, $2, $3, $4, 'SCAN', $5)
    ON CONFLICT DO NOTHING
  `,
    [row.employeeid, row.cardno || null, eventTime, 0, resolvedShiftId]
  );

  console.log(`  → ${row.employeeid} | SCAN | shift ${resolvedShiftId} | ${eventTime.toISOString()}`);
}

async function upsertSmsLog(client, params) {
  const {
    id,
    employee_id,
    phone,
    message_body,
    daily_rate_snapshot,
    textify_message_id,
    status,
    provider_error,
    raw_response,
  } = params;
  await client.query(
    `
    INSERT INTO sms_log (
      id, employee_id, work_date, phone, message_body, daily_rate_snapshot,
      textify_message_id, status, provider_error, raw_response, updated_at
    )
    VALUES ($1, $2, CURRENT_DATE, $3, $4, $5, $6, $7, $8, $9::jsonb, now())
    ON CONFLICT (employee_id, work_date) DO UPDATE SET
      phone = EXCLUDED.phone,
      message_body = EXCLUDED.message_body,
      daily_rate_snapshot = EXCLUDED.daily_rate_snapshot,
      textify_message_id = EXCLUDED.textify_message_id,
      status = EXCLUDED.status,
      provider_error = EXCLUDED.provider_error,
      raw_response = EXCLUDED.raw_response,
      updated_at = now()
  `,
    [
      id,
      employee_id,
      phone,
      message_body,
      daily_rate_snapshot,
      textify_message_id,
      status,
      provider_error,
      raw_response == null ? null : JSON.stringify(raw_response),
    ]
  );
}

const SMS_SUCCESS_STATUSES = new Set(['delivered', 'sent', 'sending', 'pending']);

async function resolveDailyEvents(client, defaultShiftId, employeeShiftMap) {
  await ensureSmartpayExtendedTables(client);
  await ensureSettings(client);
  const smsTemplate = await getSmsTemplate(client);
  const dateRow = await client.query('SELECT CURRENT_DATE::text AS d');
  const todayStr = dateRow.rows[0] && dateRow.rows[0].d ? dateRow.rows[0].d : '';

  const employees = await client.query(`
    SELECT DISTINCT employee_id FROM attendance_log
    WHERE DATE(raw_event_time) = CURRENT_DATE
  `);

  const shiftIdSet = new Set([Number(defaultShiftId)]);
  for (const { employee_id } of employees.rows) {
    const key = String(employee_id).trim();
    const sid = employeeShiftMap.get(key);
    shiftIdSet.add(sid != null && sid !== '' ? Number(sid) : Number(defaultShiftId));
  }
  const shiftMap = await loadShiftMap(client, shiftIdSet);

  for (const { employee_id } of employees.rows) {
    const scans = await client.query(
      `
      SELECT id, raw_event_time, TO_CHAR(raw_event_time, 'HH24:MI:SS') AS tclock
      FROM attendance_log
      WHERE employee_id = $1
        AND DATE(raw_event_time) = CURRENT_DATE
      ORDER BY raw_event_time ASC
    `,
      [employee_id]
    );

    if (!scans.rows.length) continue;

    const firstScan = scans.rows[0];
    const lastScan = scans.rows[scans.rows.length - 1];
    const isOneScan = scans.rows.length === 1;

    await client.query(
      `
      UPDATE attendance_log
      SET event_type = 'SCAN', payment_triggered = FALSE
      WHERE employee_id = $1
        AND DATE(raw_event_time) = CURRENT_DATE
    `,
      [employee_id]
    );

    await client.query(
      `
      UPDATE attendance_log
      SET event_type = 'CHECK_IN'
      WHERE id = $1
    `,
      [firstScan.id]
    );

    if (!isOneScan) {
      await client.query(
        `
        UPDATE attendance_log
        SET event_type = 'CHECK_OUT'
        WHERE id = $1
      `,
        [lastScan.id]
      );
    }

    const empHr = await client.query(
      `SELECT id, firstname, lastname, phonenumber, daily_rate, shift_id
       FROM employeex WHERE TRIM(id::text) = TRIM($1::text) LIMIT 1`,
      [employee_id]
    );
    const emp = empHr.rows[0];
    const effShiftId =
      emp && emp.shift_id != null && emp.shift_id !== ''
        ? Number(emp.shift_id)
        : Number(defaultShiftId);
    const shift = shiftMap.get(effShiftId) || shiftMap.get(Number(defaultShiftId));

    const firstClock = scans.rows[0].tclock;
    const lastClock = scans.rows[scans.rows.length - 1].tclock;
    const { eligibleForPayment } = evaluateShiftCompliance({
      firstScanClock: firstClock,
      lastScanClock: lastClock,
      totalScans: scans.rows.length,
      shift: shift || null,
    });

    if (isOneScan || !eligibleForPayment || !shift) {
      await client.query(
        `DELETE FROM payment_queue WHERE employee_id = $1 AND event_date = CURRENT_DATE`,
        [employee_id]
      );
      continue;
    }

    if (!emp) {
      await client.query(
        `DELETE FROM payment_queue WHERE employee_id = $1 AND event_date = CURRENT_DATE`,
        [employee_id]
      );
      continue;
    }

    const rateSnap = emp.daily_rate != null ? Number(emp.daily_rate) : 0;
    const displayName =
      `${emp.firstname || ''} ${emp.lastname || ''}`.trim() || String(employee_id);
    const phoneRaw = emp.phonenumber != null ? String(emp.phonenumber).trim() : '';
    const phoneE164 = phoneRaw ? normalizePhoneE164(phoneRaw) : null;

    const checkoutTime = lastScan.raw_event_time;

    await client.query(
      `
      INSERT INTO payment_queue
        (employee_id, event_date, checkout_time, status, compliant, amount)
      VALUES ($1, CURRENT_DATE, $2, 'PENDING', TRUE, $3)
      ON CONFLICT (employee_id, event_date) DO UPDATE SET
        checkout_time = EXCLUDED.checkout_time,
        compliant = TRUE,
        amount = EXCLUDED.amount,
        status = 'PENDING'
    `,
      [employee_id, checkoutTime, rateSnap]
    );

    await client.query(
      `
      UPDATE attendance_log
      SET payment_triggered = TRUE
      WHERE employee_id = $1
        AND event_type = 'CHECK_IN'
        AND DATE(raw_event_time) = CURRENT_DATE
    `,
      [employee_id]
    );

    const logR = await client.query(
      `SELECT id, status FROM sms_log WHERE employee_id = $1 AND work_date = CURRENT_DATE`,
      [employee_id]
    );
    const existingLog = logR.rows[0];
    if (existingLog && SMS_SUCCESS_STATUSES.has(String(existingLog.status || '').toLowerCase())) {
      console.log(`  📱 SMS already sent/sending for ${employee_id} — skip`);
      continue;
    }

    const messageBody = renderEligibilitySms(smsTemplate, {
      name: displayName,
      amount: rateSnap,
      date: todayStr,
      currency: 'TZS',
    });

    if (!phoneE164) {
      await upsertSmsLog(client, {
        id: existingLog ? existingLog.id : randomUUID(),
        employee_id: String(employee_id).trim(),
        phone: phoneRaw || null,
        message_body: messageBody,
        daily_rate_snapshot: rateSnap,
        textify_message_id: null,
        status: 'failed',
        provider_error: 'Missing or invalid phone number',
        raw_response: null,
      });
      console.warn(`  ⚠ Eligible ${employee_id} — no valid phone, SMS not sent`);
      continue;
    }

    const sendResult = await sendSms({ receiver: phoneE164, content: messageBody });
    if (sendResult.ok) {
      await upsertSmsLog(client, {
        id: existingLog ? existingLog.id : randomUUID(),
        employee_id: String(employee_id).trim(),
        phone: phoneE164,
        message_body: messageBody,
        daily_rate_snapshot: rateSnap,
        textify_message_id: sendResult.messageId || null,
        status: 'sent',
        provider_error: null,
        raw_response: sendResult.raw || null,
      });
      console.log(`  📱 SMS sent to ${employee_id} (${phoneE164})`);
    } else {
      await upsertSmsLog(client, {
        id: existingLog ? existingLog.id : randomUUID(),
        employee_id: String(employee_id).trim(),
        phone: phoneE164,
        message_body: messageBody,
        daily_rate_snapshot: rateSnap,
        textify_message_id: null,
        status: 'failed',
        provider_error: sendResult.error || 'send failed',
        raw_response: sendResult.raw || null,
      });
      console.warn(`  ⚠ SMS failed for ${employee_id}: ${sendResult.error}`);
    }
  }
}

async function poll() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS poller_state (
        key   TEXT PRIMARY KEY,
        value TEXT
      )
    `);

    const stateRow = await client.query("SELECT value FROM poller_state WHERE key = 'last_attlog_id'");
    const lastProcessed = stateRow.rows.length ? stateRow.rows[0].value : '1970-01-01 00:00:00';

    const newRows = await client.query(
      `
      SELECT * FROM attlog
      WHERE authdatetime > $1
      ORDER BY authdatetime ASC
      LIMIT 500
    `,
      [lastProcessed]
    );

    if (!newRows.rows.length) {
      console.log(`[${new Date().toISOString()}] Poll: no new rows`);
      return;
    }

    console.log(`[${new Date().toISOString()}] Poll: ${newRows.rows.length} new scan(s)`);

    const defaultShiftId = await getDefaultShiftId(client);
    const employeeShiftMap = await loadEmployeeShiftMap(client);
    const shift = await getShift(client, defaultShiftId);
    if (!shift) {
      console.warn('  ⚠ No active shift config for default_shift_id — seed shift_config first');
    }

    for (const row of newRows.rows) {
      await processRow(client, row, employeeShiftMap, defaultShiftId);
    }

    await resolveDailyEvents(client, defaultShiftId, employeeShiftMap);

    const latest = newRows.rows[newRows.rows.length - 1].authdatetime;
    await client.query(
      `
      INSERT INTO poller_state (key, value) VALUES ('last_attlog_id', $1)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `,
      [latest]
    );

    console.log(`  ✅ Watermark: ${latest}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Poll error:`, err.message);
  } finally {
    client.release();
  }
}

console.log(`🔄 SmartPay Poller starting — interval: ${POLL_INTERVAL_MS / 1000}s`);
pool.connect((err) => {
  if (err) {
    console.error('❌ DB connection failed:', err.message);
    process.exit(1);
  }
  console.log('✅ Connected to PostgreSQL (attendance)');
  poll();
  setInterval(poll, POLL_INTERVAL_MS);
});
