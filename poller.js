require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const POLL_INTERVAL_MS = 30 * 100;
const SETTING_KEY_DEFAULT_SHIFT = 'default_shift_id';

// ── SHIFT CACHE (default shift row, for poller logging / sanity) ──
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
  if (shiftCache && shiftCacheForId === shiftId && (now - shiftCachedAt) < 60000) return shiftCache;
  const r = await client.query(
    'SELECT * FROM shift_config WHERE id = $1 AND active = TRUE', [shiftId]
  );
  if (r.rows.length) {
    shiftCache = r.rows[0];
    shiftCachedAt = now;
    shiftCacheForId = shiftId;
    console.log(`  📋 Default shift: ${shiftCache.shift_name} | in ${shiftCache.checkin_start}-${shiftCache.checkin_end} | out ${shiftCache.checkout_start}-${shiftCache.checkout_end}`);
  }
  return shiftCache;
}

// ── PROCESS ROW ───────────────────────────────────────────
// All raw scans are stored as SCAN in attendance_log.
// First/last scan logic is handled at read time (compliance query).
async function processRow(client, row, employeeShiftMap, defaultShiftId) {
  const eventTime = new Date(row.authdatetime);
  if (isNaN(eventTime.getTime())) {
    console.warn(`  ⚠ Invalid datetime for employeeid=${row.employeeid}: "${row.authdatetime}" — skipping`);
    return;
  }

  const empKey = row.employeeid != null ? String(row.employeeid).trim() : '';
  const override = employeeShiftMap.get(empKey);
  const resolvedShiftId = override != null && override !== '' ? override : defaultShiftId;

  // Store every raw scan — no classification here (shift_id mirrors HR default + override)
  await client.query(`
    INSERT INTO attendance_log
      (employee_id, card_no, raw_event_time, direction, event_type, shift_id)
    VALUES ($1, $2, $3, $4, 'SCAN', $5)
    ON CONFLICT DO NOTHING
  `, [
    row.employeeid,
    row.cardno || null,
    eventTime,
    0,
    resolvedShiftId
  ]);

  console.log(`  → ${row.employeeid} | SCAN | shift ${resolvedShiftId} | ${eventTime.toISOString()}`);
}

// ── RESOLVE DAILY CHECK-IN / CHECK-OUT ───────────────────
// After each poll, recalculate first/last scan for today
// and update attendance_log event_type + payment_queue accordingly
async function resolveDailyEvents(client, shift) {
  if (!shift) return;

  // Get all employees who have scans today
  const employees = await client.query(`
    SELECT DISTINCT employee_id FROM attendance_log
    WHERE DATE(raw_event_time) = CURRENT_DATE
  `);

  for (const { employee_id } of employees.rows) {
    const scans = await client.query(`
      SELECT id, raw_event_time
      FROM attendance_log
      WHERE employee_id = $1
        AND DATE(raw_event_time) = CURRENT_DATE
      ORDER BY raw_event_time ASC
    `, [employee_id]);

    if (!scans.rows.length) continue;

    const firstScan = scans.rows[0];
    const lastScan  = scans.rows[scans.rows.length - 1];
    const isOneScan = scans.rows.length === 1;

    // Reset all today's scans for this employee to SCAN
    await client.query(`
      UPDATE attendance_log
      SET event_type = 'SCAN', payment_triggered = FALSE
      WHERE employee_id = $1
        AND DATE(raw_event_time) = CURRENT_DATE
    `, [employee_id]);

    // Mark first scan as CHECK_IN
    await client.query(`
      UPDATE attendance_log
      SET event_type = 'CHECK_IN'
      WHERE id = $1
    `, [firstScan.id]);

    // Mark last scan as CHECK_OUT (only if more than one scan)
    if (!isOneScan) {
      await client.query(`
        UPDATE attendance_log
        SET event_type = 'CHECK_OUT'
        WHERE id = $1
      `, [lastScan.id]);

      // Determine checkout compliance
      const checkoutTime = lastScan.raw_event_time.toTimeString
        ? lastScan.raw_event_time.toTimeString().slice(0, 8)
        : new Date(lastScan.raw_event_time).toTimeString().slice(0, 8);

      // Queue payment if checkout exists
      const alreadyQueued = await client.query(`
        SELECT 1 FROM payment_queue
        WHERE employee_id = $1 AND event_date = CURRENT_DATE
      `, [employee_id]);

      if (!alreadyQueued.rows.length) {
        await client.query(`
          INSERT INTO payment_queue
            (employee_id, event_date, checkout_time, status)
          VALUES ($1, CURRENT_DATE, $2, 'PENDING')
          ON CONFLICT (employee_id, event_date) DO UPDATE
            SET checkout_time = EXCLUDED.checkout_time
        `, [employee_id, lastScan.raw_event_time]);

        console.log(`  💳 Payment queued for ${employee_id} | checkout ${checkoutTime}`);
      } else {
        // Update checkout time to latest scan
        await client.query(`
          UPDATE payment_queue
          SET checkout_time = $1
          WHERE employee_id = $2 AND event_date = CURRENT_DATE
        `, [lastScan.raw_event_time, employee_id]);
      }

      // Mark check-in as payment_triggered
      await client.query(`
        UPDATE attendance_log
        SET payment_triggered = TRUE
        WHERE employee_id = $1
          AND event_type = 'CHECK_IN'
          AND DATE(raw_event_time) = CURRENT_DATE
      `, [employee_id]);
    }
  }
}

// ── POLL ──────────────────────────────────────────────────
async function poll() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS poller_state (
        key   TEXT PRIMARY KEY,
        value TEXT
      )
    `);

    const stateRow = await client.query(
      "SELECT value FROM poller_state WHERE key = 'last_attlog_id'"
    );
    const lastProcessed = stateRow.rows.length
      ? stateRow.rows[0].value
      : '1970-01-01 00:00:00';

    const newRows = await client.query(`
      SELECT * FROM attlog
      WHERE authdatetime > $1
      ORDER BY authdatetime ASC
      LIMIT 500
    `, [lastProcessed]);

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

    // Recalculate first/last scan classifications for today
    await resolveDailyEvents(client, shift);

    const latest = newRows.rows[newRows.rows.length - 1].authdatetime;
    await client.query(`
      INSERT INTO poller_state (key, value) VALUES ('last_attlog_id', $1)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `, [latest]);

    console.log(`  ✅ Watermark: ${latest}`);

  } catch (err) {
    console.error(`[${new Date().toISOString()}] Poll error:`, err.message);
  } finally {
    client.release();
  }
}

// ── START ─────────────────────────────────────────────────
console.log(`🔄 SmartPay Poller starting — interval: ${POLL_INTERVAL_MS / 1000}s`);
pool.connect((err) => {
  if (err) { console.error('❌ DB connection failed:', err.message); process.exit(1); }
  console.log('✅ Connected to PostgreSQL (attendance)');
  poll();
  setInterval(poll, POLL_INTERVAL_MS);
});
