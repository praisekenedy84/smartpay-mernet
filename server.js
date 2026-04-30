require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { fork } = require('child_process');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// DB Pool
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

pool.connect((err) => {
  if (err) {
    console.error('❌ Database connection failed:', err.message);
  } else {
    console.log('✅ Connected to PostgreSQL (attendance)');
  }
});

// ── Global default shift (per-employee override: employeex.shift_id) ──
const SETTING_KEY_DEFAULT_SHIFT = 'default_shift_id';

async function ensureSmartpaySettingsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS smartpay_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  await pool.query(
    `INSERT INTO smartpay_settings (key, value) VALUES ($1, '1')
     ON CONFLICT (key) DO NOTHING`,
    [SETTING_KEY_DEFAULT_SHIFT]
  );
}

/** Scalar subquery: default shift id from settings (falls back to 1). */
function sqlDefaultShiftIdScalar() {
  return `(SELECT COALESCE(NULLIF(TRIM(value), '')::int, 1) FROM smartpay_settings WHERE key = '${SETTING_KEY_DEFAULT_SHIFT}' LIMIT 1)`;
}

/** Effective shift when grouped with employeex as e (MAX aggregates one row per employee). */
function sqlEffectiveShiftIdFromEmployeex() {
  return `COALESCE(MAX(e.shift_id), ${sqlDefaultShiftIdScalar()}, 1)`;
}

/** Effective shift for a single joined employeex row (e.g. live feed). */
function sqlEffectiveShiftIdLive() {
  return `COALESCE(e.shift_id, ${sqlDefaultShiftIdScalar()}, 1)`;
}

async function getDefaultShiftIdFromDb() {
  await ensureSmartpaySettingsTable();
  const r = await pool.query(
    `SELECT COALESCE(NULLIF(TRIM(value), '')::int, 1) AS id
     FROM smartpay_settings WHERE key = $1 LIMIT 1`,
    [SETTING_KEY_DEFAULT_SHIFT]
  );
  const id = r.rows[0] && r.rows[0].id;
  return typeof id === 'number' && !Number.isNaN(id) ? id : 1;
}

// ── attlog column detection (HIKCentral often uses quoted mixed-case cols, e.g. "personName", "employeeID") ──
let _attlogSchemaCache = null;

function quotePgIdent(name) {
  if (!name) return '';
  const s = String(name);
  if (/^[a-z_][a-z0-9_]*$/.test(s)) return s;
  return '"' + s.replace(/"/g, '""') + '"';
}

function findColumnI(cols, want) {
  const w = want.toLowerCase();
  for (const c of cols) {
    if (String(c).toLowerCase() === w) return c;
  }
  return null;
}

async function getAttlogSchema() {
  if (_attlogSchemaCache) return _attlogSchemaCache;
  const r = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = CURRENT_SCHEMA() AND table_name = 'attlog'
    ORDER BY ordinal_position
  `);
  const cols = r.rows.map((x) => x.column_name);
  const idRaw =
    findColumnI(cols, 'employeeid') ||
    findColumnI(cols, 'employee_id') ||
    findColumnI(cols, 'employeeID');

  const a = 'a';
  let displayMaxSql = null;
  let displayTrimSqlTemplate = null;
  const fn = findColumnI(cols, 'firstname') || findColumnI(cols, 'first_name');
  const ln = findColumnI(cols, 'lastname') || findColumnI(cols, 'last_name');
  if (fn && ln) {
    const fq = quotePgIdent(fn);
    const lq = quotePgIdent(ln);
    displayTrimSqlTemplate = `NULLIF(TRIM(CONCAT_WS(' ', NULLIF(TRIM(${a}.${fq}::text), ''), NULLIF(TRIM(${a}.${lq}::text), ''))), '')`;
    displayMaxSql = `MAX(${displayTrimSqlTemplate})`;
  } else {
    for (const cand of [
      'personname',
      'person_name',
      'personName',
      'cardholdername',
      'employeename',
      'username',
      'name',
    ]) {
      const c = findColumnI(cols, cand);
      if (c) {
        displayTrimSqlTemplate = `NULLIF(TRIM(${a}.${quotePgIdent(c)}::text), '')`;
        displayMaxSql = `MAX(${displayTrimSqlTemplate})`;
        break;
      }
    }
  }

  const idCol = idRaw ? quotePgIdent(idRaw) : null;
  const dtRaw =
    findColumnI(cols, 'authdatetime') ||
    findColumnI(cols, 'auth_date_time') ||
    findColumnI(cols, 'authDateTime');
  const authDtCol = dtRaw ? quotePgIdent(dtRaw) : 'authdatetime';

  _attlogSchemaCache = { cols, idCol, displayMaxSql, displayTrimSqlTemplate, authDtCol };
  if (idCol) {
    console.log(
      `[attlog] id column: ${idCol} | name field: ${displayMaxSql ? 'resolved' : 'none'} | time: ${authDtCol}`
    );
  } else {
    console.warn('[attlog] no employee id column found — check table name / schema');
  }
  return _attlogSchemaCache;
}

/** HR name (employeex), else latest attlog display name, else employee id. Call after getAttlogSchema(). */
function buildDisplayNameSql(employeeIdRef, eAlias = 'e') {
  const s = _attlogSchemaCache;
  const hr = `NULLIF(TRIM(CONCAT_WS(' ', NULLIF(TRIM(${eAlias}.firstname::text), ''), NULLIF(TRIM(${eAlias}.lastname::text), ''))), '')`;
  if (!s || !s.idCol || !s.displayTrimSqlTemplate) {
    return `COALESCE(${hr}, TRIM(${employeeIdRef}::text))`;
  }
  const inner = s.displayTrimSqlTemplate.replace(/\ba\./g, 'a2.');
  return `COALESCE(
    ${hr},
    (SELECT ${inner} FROM attlog a2 WHERE TRIM(a2.${s.idCol}::text) = TRIM(${employeeIdRef}::text) ORDER BY a2.${s.authDtCol} DESC NULLS LAST LIMIT 1),
    TRIM(${employeeIdRef}::text)
  )`;
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── ROUTES ────────────────────────────────────────────────

// Live feed: today's attendance events
app.get('/api/attendance/live', async (req, res) => {
  try {
    await getAttlogSchema();
    const dn = buildDisplayNameSql('al.employee_id');
    await ensureSmartpaySettingsTable();
    const eff = sqlEffectiveShiftIdLive();
    const result = await pool.query(`
      SELECT
        al.employee_id,
        e.firstname,
        e.lastname,
        (${dn}) AS display_name,
        al.event_type,
        al.raw_event_time,
        (${eff}) AS shift_id,
        al.payment_triggered
      FROM attendance_log al
      LEFT JOIN employeex e ON e.id = al.employee_id
      WHERE DATE(al.raw_event_time) = CURRENT_DATE
      ORDER BY al.raw_event_time DESC
      LIMIT 100
    `);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Daily summary: per employee today
app.get('/api/attendance/summary', async (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  try {
    await getAttlogSchema();
    const dn = buildDisplayNameSql('al.employee_id');
    const result = await pool.query(`
      SELECT
        al.employee_id,
        e.firstname,
        e.lastname,
        MIN((${dn})) AS display_name,
        e.phonenumber,
        MIN(CASE WHEN al.event_type = 'CHECK_IN'  THEN al.raw_event_time END) AS check_in,
        MAX(CASE WHEN al.event_type = 'CHECK_OUT' THEN al.raw_event_time END) AS check_out,
        BOOL_OR(al.payment_triggered) AS payment_triggered,
        COUNT(*) AS total_events
      FROM attendance_log al
      LEFT JOIN employeex e ON e.id = al.employee_id
      WHERE DATE(al.raw_event_time) = $1
      GROUP BY al.employee_id, e.firstname, e.lastname, e.phonenumber
      ORDER BY MIN(al.raw_event_time) DESC
    `, [date]);
    res.json({ success: true, date, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// All raw scans for one employee on one day (Daily Summary drill-down)
app.get('/api/attendance/scans', async (req, res) => {
  const date = (req.query.date || '').trim();
  const employee_id = req.query.employee_id;
  if (!date || employee_id === undefined || employee_id === null || String(employee_id).trim() === '') {
    return res.status(400).json({ success: false, error: 'date and employee_id required' });
  }
  try {
    const result = await pool.query(
      `
      SELECT id, raw_event_time, event_type, direction, shift_id, payment_triggered, card_no
      FROM attendance_log
      WHERE DATE(raw_event_time) = $1::date AND TRIM(employee_id::text) = TRIM($2::text)
      ORDER BY raw_event_time ASC
      `,
      [date, String(employee_id)]
    );
    res.json({ success: true, date, employee_id: String(employee_id).trim(), data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Stats: counts for today
app.get('/api/stats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(DISTINCT CASE WHEN event_type = 'CHECK_IN'  THEN employee_id END) AS checked_in,
        COUNT(DISTINCT CASE WHEN event_type = 'CHECK_OUT' THEN employee_id END) AS checked_out,
        COUNT(DISTINCT employee_id) AS total_employees,
        COUNT(DISTINCT CASE WHEN payment_triggered = TRUE THEN employee_id END) AS payments_queued
      FROM attendance_log
      WHERE DATE(raw_event_time) = CURRENT_DATE
    `);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Shift compliance: first scan = check-in, last scan = effective check-out
app.get('/api/attendance/compliance', async (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  try {
    await getAttlogSchema();
    await ensureSmartpaySettingsTable();
    const dn = buildDisplayNameSql('al.employee_id');
    const effShift = sqlEffectiveShiftIdFromEmployeex();
    const result = await pool.query(`
      WITH day_scans AS (
        SELECT
          al.employee_id,
          e.firstname,
          e.lastname,
          MIN((${dn}))                            AS display_name,
          e.phonenumber,
          MIN(al.raw_event_time)                  AS check_in,
          MAX(al.raw_event_time)                  AS last_scan,
          COUNT(*)                                AS total_scans,
          (MAX(e.shift_id) IS NULL)               AS shift_is_default,
          (${effShift})                           AS shift_id,
          BOOL_OR(al.payment_triggered)           AS payment_triggered
        FROM attendance_log al
        LEFT JOIN employeex e ON e.id = al.employee_id
        WHERE DATE(al.raw_event_time) = $1
        GROUP BY al.employee_id, e.firstname, e.lastname, e.phonenumber
      ),
      with_shift AS (
        SELECT
          d.*,
          -- effective checkout = last scan (if more than one scan)
          CASE WHEN d.total_scans > 1 THEN d.last_scan ELSE NULL END AS check_out,
          s.shift_name,
          s.checkin_start,
          s.checkin_end,
          s.checkout_start,
          s.checkout_end,
          -- check-in status
          CASE
            WHEN d.check_in IS NULL                          THEN 'ABSENT'
            WHEN d.check_in::TIME <= s.checkin_end           THEN 'ON TIME'
            ELSE 'LATE'
          END AS checkin_status,
          -- checkout status based on last scan
          CASE
            WHEN d.total_scans <= 1                          THEN 'NOT OUT'
            WHEN d.last_scan::TIME < s.checkout_start        THEN 'EARLY OUT'
            WHEN d.last_scan::TIME > s.checkout_end          THEN 'LEFT LATE'
            ELSE 'ON TIME'
          END AS checkout_status,
          -- minutes late on check-in (positive = late)
          CASE
            WHEN d.check_in IS NOT NULL
            THEN ROUND(EXTRACT(EPOCH FROM (d.check_in::TIME - s.checkin_end)) / 60)
            ELSE NULL
          END AS minutes_late,
          -- minutes deviation on checkout
          -- positive = left early, negative = left late
          CASE
            WHEN d.total_scans > 1 AND d.last_scan::TIME < s.checkout_start
            THEN ROUND(EXTRACT(EPOCH FROM (s.checkout_start - d.last_scan::TIME)) / 60)
            WHEN d.total_scans > 1 AND d.last_scan::TIME > s.checkout_end
            THEN ROUND(EXTRACT(EPOCH FROM (d.last_scan::TIME - s.checkout_end)) / 60) * -1
            ELSE 0
          END AS minutes_early_out
        FROM day_scans d
        LEFT JOIN shift_config s ON s.id = d.shift_id
      )
      SELECT * FROM with_shift ORDER BY check_in ASC NULLS LAST
    `, [date]);
    res.json({ success: true, date, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Raw attlog: last N rows received from HIKCentral
app.get('/api/attlog/recent', async (req, res) => {
  try {
    const { authDtCol } = await getAttlogSchema();
    const result = await pool.query(`
      SELECT * FROM attlog
      ORDER BY ${authDtCol} DESC
      LIMIT 20
    `);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── ADMIN ROUTES (password protected) ────────────────────

function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query['x-admin-token'];
  if (token !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

// Get shift config (+ company default shift id for all employees without an override)
app.get('/api/admin/shifts', adminAuth, async (req, res) => {
  try {
    await ensureSmartpaySettingsTable();
    const result = await pool.query('SELECT * FROM shift_config ORDER BY id');
    const default_shift_id = await getDefaultShiftIdFromDb();
    res.json({ success: true, data: result.rows, default_shift_id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Set global default shift (used when employeex.shift_id IS NULL)
app.put('/api/admin/settings/default-shift', adminAuth, async (req, res) => {
  const raw = req.body && req.body.shift_id;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) {
    return res.status(400).json({ success: false, error: 'Valid shift_id required' });
  }
  try {
    await ensureSmartpaySettingsTable();
    const ok = await pool.query('SELECT 1 FROM shift_config WHERE id = $1', [n]);
    if (!ok.rows.length) {
      return res.status(400).json({ success: false, error: 'Shift does not exist' });
    }
    await pool.query(
      `INSERT INTO smartpay_settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [SETTING_KEY_DEFAULT_SHIFT, String(n)]
    );
    res.json({ success: true, default_shift_id: n });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Add new shift
app.post('/api/admin/shifts', adminAuth, async (req, res) => {
  const { shift_name, checkin_start, checkin_end, checkout_start, checkout_end } = req.body;
  if (!shift_name) return res.status(400).json({ success: false, error: 'shift_name required' });
  try {
    await pool.query(`
      INSERT INTO shift_config (shift_name, checkin_start, checkin_end, checkout_start, checkout_end, active)
      VALUES ($1, $2, $3, $4, $5, TRUE)
    `, [shift_name, checkin_start, checkin_end, checkout_start, checkout_end]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update shift config
app.put('/api/admin/shifts/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { checkin_start, checkin_end, checkout_start, checkout_end } = req.body;
  try {
    await pool.query(`
      UPDATE shift_config
      SET checkin_start=$1, checkin_end=$2, checkout_start=$3, checkout_end=$4, updated_at=now()
      WHERE id=$5
    `, [checkin_start, checkin_end, checkout_start, checkout_end, id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// List employees
app.get('/api/admin/employees', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM employeex ORDER BY firstname');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Add / update employee
app.post('/api/admin/employees', adminAuth, async (req, res) => {
  const { id, firstname, lastname, phonenumber, daily_rate, provider, shift_id } = req.body;
  if (!id) return res.status(400).json({ success: false, error: 'id required' });
  let sid = shift_id;
  if (sid === '' || sid === undefined || sid === null) sid = null;
  else {
    sid = parseInt(sid, 10);
    if (Number.isNaN(sid)) sid = null;
  }
  try {
    // Ensure shift_id column exists
    await pool.query(`ALTER TABLE employeex ADD COLUMN IF NOT EXISTS shift_id INT REFERENCES shift_config(id)`).catch(()=>{});
    await pool.query(`
      INSERT INTO employeex (id, firstname, lastname, phonenumber, daily_rate, provider, shift_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (id) DO UPDATE
        SET firstname=$2, lastname=$3, phonenumber=$4, daily_rate=$5, provider=$6, shift_id=$7
    `, [id, firstname, lastname, phonenumber, daily_rate||0, provider, sid]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// Distinct employees seen in HIKCentral attlog (enriched from employeex when present)
app.get('/api/employees/from-attlog', async (req, res) => {
  try {
    await ensureSmartpaySettingsTable();
    const { idCol, displayMaxSql, authDtCol } = await getAttlogSchema();
    if (!idCol) {
      return res.status(500).json({ success: false, error: 'attlog has no recognizable employee id column' });
    }
    const effShift = sqlEffectiveShiftIdFromEmployeex();
    let selectExtras = `(MAX(e.shift_id) IS NULL) AS shift_is_default, (${effShift}) AS shift_id`;
    if (displayMaxSql) {
      selectExtras += `,\n      ${displayMaxSql} AS attlog_name`;
      selectExtras += `,\n      COALESCE(NULLIF(TRIM(CONCAT_WS(' ', MAX(e.firstname), MAX(e.lastname))), ''), ${displayMaxSql}) AS display_name`;
    } else {
      selectExtras += `,\n      NULLIF(TRIM(CONCAT_WS(' ', MAX(e.firstname), MAX(e.lastname))), '') AS display_name`;
    }
    const sql = `
      SELECT
        a.${idCol}::text AS id,
        MAX(a.${authDtCol}) AS last_swipe_at,
        COUNT(*)::bigint AS swipe_count,
        MAX(e.firstname) AS firstname,
        MAX(e.lastname) AS lastname,
        MAX(e.phonenumber) AS phonenumber,
        MAX(e.daily_rate) AS daily_rate,
        MAX(e.provider) AS provider,
        ${selectExtras}
      FROM attlog a
      LEFT JOIN employeex e ON TRIM(e.id) = TRIM(a.${idCol}::text)
      GROUP BY a.${idCol}
      ORDER BY MAX(a.${authDtCol}) DESC NULLS LAST
    `;
    const result = await pool.query(sql);
    return res.json({ success: true, data: result.rows });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── EMPLOYEE ROUTES (public - for dropdown search) ───────
app.get('/api/employees/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  try {
    const result = await pool.query(`
      SELECT id, firstname, lastname, phonenumber, daily_rate, provider, shift_id
      FROM employeex
      WHERE id ILIKE $1 OR firstname ILIKE $1 OR lastname ILIKE $1
      ORDER BY firstname LIMIT 20
    `, ['%' + q + '%']);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get single employee (employeex row, or stub from attlog when they swiped but are not in HR yet)
app.get('/api/admin/employees/:id', adminAuth, async (req, res) => {
  const rawId = req.params.id;
  try {
    const ex = await pool.query('SELECT * FROM employeex WHERE TRIM(id) = TRIM($1)', [rawId]);
    if (ex.rows.length) {
      return res.json({ success: true, data: ex.rows[0] });
    }

    const { idCol, displayMaxSql } = await getAttlogSchema();
    if (!idCol) {
      return res.status(500).json({ success: false, error: 'attlog schema not available' });
    }

    const inLog = await pool.query(
      `SELECT COUNT(*)::int AS n, MAX(a.${idCol}::text) AS canonical_id
       FROM attlog a WHERE TRIM(a.${idCol}::text) = TRIM($1)`,
      [rawId]
    );
    if (!inLog.rows[0] || inLog.rows[0].n === 0) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }

    const idOut = inLog.rows[0].canonical_id || rawId;
    let fullName = '';
    if (displayMaxSql) {
      const pn = await pool.query(
        `SELECT ${displayMaxSql} AS disp FROM attlog a WHERE TRIM(a.${idCol}::text) = TRIM($1)`,
        [rawId]
      );
      fullName = pn.rows[0] && pn.rows[0].disp ? String(pn.rows[0].disp).trim() : '';
    }

    let firstname = '';
    let lastname = '';
    if (fullName) {
      const sp = fullName.indexOf(' ');
      if (sp === -1) firstname = fullName;
      else {
        firstname = fullName.slice(0, sp);
        lastname = fullName.slice(sp + 1).trim();
      }
    }

    return res.json({
      success: true,
      data: {
        id: idOut,
        firstname,
        lastname,
        phonenumber: null,
        daily_rate: null,
        provider: null,
        shift_id: null,
      },
      from_attlog_stub: true,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete employee (employeex only; attlog is HIKCentral — cannot delete swipes here)
app.delete('/api/admin/employees/:id', adminAuth, async (req, res) => {
  const rawId = req.params.id;
  try {
    const del = await pool.query('DELETE FROM employeex WHERE TRIM(id) = TRIM($1)', [rawId]);
    if (del.rowCount > 0) {
      return res.json({ success: true });
    }

    const { idCol } = await getAttlogSchema();
    if (!idCol) {
      return res.json({ success: true, noop: true });
    }
    const still = await pool.query(
      `SELECT 1 FROM attlog a WHERE TRIM(a.${idCol}::text) = TRIM($1) LIMIT 1`,
      [rawId]
    );
    if (still.rows.length) {
      return res.json({
        success: true,
        only_in_attlog: true,
        message:
          'This ID is only in attlog (not in the HR register). Use Edit → Save to add them to the register, or remove their device events in HIKCentral.',
      });
    }

    return res.json({ success: true, noop: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Assign employee to shift (null / omit = use company default shift)
app.put('/api/admin/employees/:id/shift', adminAuth, async (req, res) => {
  let sid = req.body && req.body.shift_id;
  if (sid === '' || sid === undefined) sid = null;
  if (sid != null) sid = parseInt(sid, 10);
  if (sid != null && Number.isNaN(sid)) {
    return res.status(400).json({ success: false, error: 'Invalid shift_id' });
  }
  try {
    await pool.query('UPDATE employeex SET shift_id = $1 WHERE TRIM(id) = TRIM($2)', [sid, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── REPORT ENDPOINTS ──────────────────────────────────────

// Daily report data
app.get('/api/reports/daily', adminAuth, async (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  try {
    await getAttlogSchema();
    await ensureSmartpaySettingsTable();
    const dn = buildDisplayNameSql('al.employee_id');
    const effShift = sqlEffectiveShiftIdFromEmployeex();
    const result = await pool.query(`
      WITH day_scans AS (
        SELECT
          al.employee_id,
          e.firstname, e.lastname, e.phonenumber,
          MIN((${dn})) AS display_name,
          MIN(al.raw_event_time) AS check_in,
          MAX(al.raw_event_time) AS last_scan,
          COUNT(*) AS total_scans,
          (${effShift}) AS shift_id
        FROM attendance_log al
        LEFT JOIN employeex e ON e.id = al.employee_id
        WHERE DATE(al.raw_event_time) = $1
        GROUP BY al.employee_id, e.firstname, e.lastname, e.phonenumber
      )
      SELECT
        d.*,
        d.display_name AS name,
        CASE WHEN d.total_scans > 1 THEN d.last_scan ELSE NULL END AS check_out,
        s.shift_name, s.checkin_start, s.checkin_end, s.checkout_start, s.checkout_end,
        CASE
          WHEN d.check_in IS NULL THEN 'ABSENT'
          WHEN d.check_in::TIME <= s.checkin_end THEN 'ON TIME'
          ELSE 'LATE'
        END AS checkin_status,
        CASE
          WHEN d.total_scans <= 1 THEN 'NOT OUT'
          WHEN d.last_scan::TIME < s.checkout_start THEN 'EARLY OUT'
          WHEN d.last_scan::TIME > s.checkout_end THEN 'LEFT LATE'
          ELSE 'ON TIME'
        END AS checkout_status,
        CASE WHEN d.check_in IS NOT NULL
          THEN ROUND(EXTRACT(EPOCH FROM (d.check_in::TIME - s.checkin_end)) / 60)
          ELSE NULL END AS minutes_late,
        CASE
          WHEN d.total_scans > 1 AND d.last_scan::TIME < s.checkout_start
          THEN ROUND(EXTRACT(EPOCH FROM (s.checkout_start - d.last_scan::TIME)) / 60)
          WHEN d.total_scans > 1 AND d.last_scan::TIME > s.checkout_end
          THEN ROUND(EXTRACT(EPOCH FROM (d.last_scan::TIME - s.checkout_end)) / 60) * -1
          ELSE 0 END AS minutes_deviation
      FROM day_scans d
      LEFT JOIN shift_config s ON s.id = d.shift_id
      ORDER BY d.check_in ASC NULLS LAST
    `, [date]);
    res.json({ success: true, date, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Monthly report data
app.get('/api/reports/monthly', adminAuth, async (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ success: false, error: 'year and month required' });
  try {
    await getAttlogSchema();
    await ensureSmartpaySettingsTable();
    const dn = buildDisplayNameSql('al.employee_id');
    const effShift = sqlEffectiveShiftIdFromEmployeex();
    const result = await pool.query(`
      WITH day_scans AS (
        SELECT
          al.employee_id,
          e.firstname, e.lastname,
          MIN((${dn})) AS display_name,
          DATE(al.raw_event_time) AS work_date,
          MIN(al.raw_event_time) AS check_in,
          MAX(al.raw_event_time) AS last_scan,
          COUNT(*) AS total_scans,
          (${effShift}) AS shift_id
        FROM attendance_log al
        LEFT JOIN employeex e ON e.id = al.employee_id
        WHERE EXTRACT(YEAR FROM al.raw_event_time) = $1
          AND EXTRACT(MONTH FROM al.raw_event_time) = $2
        GROUP BY al.employee_id, e.firstname, e.lastname, DATE(al.raw_event_time)
      )
      SELECT
        d.*,
        d.display_name AS name,
        CASE WHEN d.total_scans > 1 THEN d.last_scan ELSE NULL END AS check_out,
        s.shift_name,
        s.checkin_start, s.checkin_end, s.checkout_start, s.checkout_end,
        CASE
          WHEN d.check_in IS NULL THEN 'ABSENT'
          WHEN d.check_in::TIME <= s.checkin_end THEN 'ON TIME'
          ELSE 'LATE'
        END AS checkin_status,
        CASE
          WHEN d.total_scans <= 1 THEN 'NOT OUT'
          WHEN d.last_scan::TIME < s.checkout_start THEN 'EARLY OUT'
          WHEN d.last_scan::TIME > s.checkout_end THEN 'LEFT LATE'
          ELSE 'ON TIME'
        END AS checkout_status,
        CASE WHEN d.check_in IS NOT NULL
          THEN ROUND(EXTRACT(EPOCH FROM (d.check_in::TIME - s.checkin_end)) / 60)
          ELSE NULL END AS minutes_late,
        CASE
          WHEN d.total_scans > 1 AND d.last_scan::TIME < s.checkout_start
          THEN ROUND(EXTRACT(EPOCH FROM (s.checkout_start - d.last_scan::TIME)) / 60)
          WHEN d.total_scans > 1 AND d.last_scan::TIME > s.checkout_end
          THEN ROUND(EXTRACT(EPOCH FROM (d.last_scan::TIME - s.checkout_end)) / 60) * -1
          ELSE 0 END AS minutes_deviation
      FROM day_scans d
      LEFT JOIN shift_config s ON s.id = d.shift_id
      ORDER BY d.employee_id, d.work_date ASC
    `, [year, month]);
    res.json({ success: true, year, month, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Excel export
app.get('/api/reports/export/excel', adminAuth, async (req, res) => {
  const { type, date, year, month } = req.query;
  try {
    await getAttlogSchema();
    await ensureSmartpaySettingsTable();
    const dn = buildDisplayNameSql('al.employee_id');
    const effShift = sqlEffectiveShiftIdFromEmployeex();
    let rows, title, filename;
    if (type === 'daily') {
      const r = await pool.query(`
        WITH day_scans AS (
          SELECT al.employee_id, e.firstname, e.lastname, e.phonenumber,
            MIN((${dn})) AS display_name,
            MIN(al.raw_event_time) AS check_in, MAX(al.raw_event_time) AS last_scan,
            COUNT(*) AS total_scans, (${effShift}) AS shift_id
          FROM attendance_log al LEFT JOIN employeex e ON e.id = al.employee_id
          WHERE DATE(al.raw_event_time) = $1
          GROUP BY al.employee_id, e.firstname, e.lastname, e.phonenumber
        )
        SELECT d.employee_id,
          d.display_name AS name,
          d.phonenumber,
          TO_CHAR(d.check_in, 'HH24:MI:SS') AS check_in,
          CASE WHEN d.total_scans > 1 THEN TO_CHAR(d.last_scan, 'HH24:MI:SS') ELSE '—' END AS check_out,
          d.total_scans,
          CASE WHEN d.check_in IS NULL THEN 'ABSENT' WHEN d.check_in::TIME <= s.checkin_end THEN 'ON TIME' ELSE 'LATE' END AS checkin_status,
          CASE WHEN d.total_scans <= 1 THEN 'NOT OUT' WHEN d.last_scan::TIME < s.checkout_start THEN 'EARLY OUT' WHEN d.last_scan::TIME > s.checkout_end THEN 'LEFT LATE' ELSE 'ON TIME' END AS checkout_status,
          CASE WHEN d.check_in IS NOT NULL THEN ROUND(EXTRACT(EPOCH FROM (d.check_in::TIME - s.checkin_end)) / 60) ELSE NULL END AS minutes_late,
          s.shift_name
        FROM day_scans d LEFT JOIN shift_config s ON s.id = d.shift_id
        ORDER BY d.check_in ASC NULLS LAST
      `, [date]);
      rows = r.rows; title = 'Daily Report — ' + date; filename = 'attendance_daily_' + date + '.xlsx';
    } else {
      const r = await pool.query(`
        WITH day_scans AS (
          SELECT al.employee_id, e.firstname, e.lastname,
            MIN((${dn})) AS display_name,
            DATE(al.raw_event_time) AS work_date,
            MIN(al.raw_event_time) AS check_in, MAX(al.raw_event_time) AS last_scan,
            COUNT(*) AS total_scans, (${effShift}) AS shift_id
          FROM attendance_log al LEFT JOIN employeex e ON e.id = al.employee_id
          WHERE EXTRACT(YEAR FROM al.raw_event_time) = $1
            AND EXTRACT(MONTH FROM al.raw_event_time) = $2
          GROUP BY al.employee_id, e.firstname, e.lastname, DATE(al.raw_event_time)
        )
        SELECT TO_CHAR(d.work_date,'YYYY-MM-DD') AS date, d.employee_id,
          d.display_name AS name,
          TO_CHAR(d.check_in, 'HH24:MI:SS') AS check_in,
          CASE WHEN d.total_scans > 1 THEN TO_CHAR(d.last_scan, 'HH24:MI:SS') ELSE '—' END AS check_out,
          d.total_scans,
          CASE WHEN d.check_in IS NULL THEN 'ABSENT' WHEN d.check_in::TIME <= s.checkin_end THEN 'ON TIME' ELSE 'LATE' END AS checkin_status,
          CASE WHEN d.total_scans <= 1 THEN 'NOT OUT' WHEN d.last_scan::TIME < s.checkout_start THEN 'EARLY OUT' WHEN d.last_scan::TIME > s.checkout_end THEN 'LEFT LATE' ELSE 'ON TIME' END AS checkout_status,
          CASE WHEN d.check_in IS NOT NULL THEN ROUND(EXTRACT(EPOCH FROM (d.check_in::TIME - s.checkin_end)) / 60) ELSE NULL END AS minutes_late,
          s.shift_name
        FROM day_scans d LEFT JOIN shift_config s ON s.id = d.shift_id
        ORDER BY d.employee_id, d.work_date ASC
      `, [year, month]);
      rows = r.rows;
      const mName = new Date(year, month-1, 1).toLocaleString('default',{month:'long'});
      title = `Monthly Report — ${mName} ${year}`;
      filename = `attendance_monthly_${year}_${month.toString().padStart(2,'0')}.xlsx`;
    }

    // Build XLSX using ExcelJS (added to package.json)
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'SmartPay';
    const ws = wb.addWorksheet('Attendance');

    // Title row
    ws.mergeCells('A1:K1');
    ws.getCell('A1').value = title;
    ws.getCell('A1').font = { bold: true, size: 14 };
    ws.getCell('A1').alignment = { horizontal: 'center' };

    // Headers
    const headers = type === 'daily'
      ? ['Employee ID','Name','Phone','Check In','Check Out','Scans','In Status','Out Status','Min Late','Shift']
      : ['Date','Employee ID','Name','Check In','Check Out','Scans','In Status','Out Status','Min Late','Shift'];
    const headerRow = ws.addRow(headers);
    headerRow.font = { bold: true };
    headerRow.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF1A2332' } };
    headerRow.font = { bold: true, color:{ argb:'FFFFFFFF' } };

    // Status color map
    const statusColor = {
      'ON TIME':   'FF00A572',
      'LATE':      'FFD42A4A',
      'EARLY OUT': 'FFC97000',
      'LEFT LATE': 'FF9933FF',
      'NOT OUT':   'FF6B7280',
      'ABSENT':    'FFD42A4A',
    };

    // Data rows
    rows.forEach(row => {
      const vals = type === 'daily'
        ? [row.employee_id, row.name, row.phonenumber||'', row.check_in||'', row.check_out||'', row.total_scans, row.checkin_status, row.checkout_status, row.minutes_late||0, row.shift_name||'']
        : [row.date, row.employee_id, row.name, row.check_in||'', row.check_out||'', row.total_scans, row.checkin_status, row.checkout_status, row.minutes_late||0, row.shift_name||''];
      const r = ws.addRow(vals);
      const inStatusIdx  = type === 'daily' ? 7 : 7;
      const outStatusIdx = type === 'daily' ? 8 : 8;
      [inStatusIdx, outStatusIdx].forEach(ci => {
        const cell = r.getCell(ci);
        const color = statusColor[cell.value] || 'FF6B7280';
        cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb: color } };
        cell.font = { color:{ argb:'FFFFFFFF' }, bold: true };
      });
    });

    // Column widths
    ws.columns.forEach(col => { col.width = 16; });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Excel export error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PDF export
app.get('/api/reports/export/pdf', adminAuth, async (req, res) => {
  const { type, date, year, month } = req.query;
  try {
    await getAttlogSchema();
    await ensureSmartpaySettingsTable();
    const dn = buildDisplayNameSql('al.employee_id');
    const effShift = sqlEffectiveShiftIdFromEmployeex();
    let rows, title, filename, isMonthly;
    if (type === 'daily') {
      const r = await pool.query(`
        WITH day_scans AS (
          SELECT al.employee_id, e.firstname, e.lastname, e.phonenumber,
            MIN((${dn})) AS display_name,
            MIN(al.raw_event_time) AS check_in, MAX(al.raw_event_time) AS last_scan,
            COUNT(*) AS total_scans, (${effShift}) AS shift_id
          FROM attendance_log al LEFT JOIN employeex e ON e.id = al.employee_id
          WHERE DATE(al.raw_event_time) = $1
          GROUP BY al.employee_id, e.firstname, e.lastname, e.phonenumber
        )
        SELECT d.employee_id,
          d.display_name AS name,
          TO_CHAR(d.check_in, 'HH24:MI') AS check_in,
          CASE WHEN d.total_scans > 1 THEN TO_CHAR(d.last_scan, 'HH24:MI') ELSE '—' END AS check_out,
          d.total_scans,
          CASE WHEN d.check_in IS NULL THEN 'ABSENT' WHEN d.check_in::TIME <= s.checkin_end THEN 'ON TIME' ELSE 'LATE' END AS checkin_status,
          CASE WHEN d.total_scans <= 1 THEN 'NOT OUT' WHEN d.last_scan::TIME < s.checkout_start THEN 'EARLY OUT' WHEN d.last_scan::TIME > s.checkout_end THEN 'LEFT LATE' ELSE 'ON TIME' END AS checkout_status,
          CASE WHEN d.check_in IS NOT NULL THEN ROUND(EXTRACT(EPOCH FROM (d.check_in::TIME - s.checkin_end)) / 60) ELSE 0 END AS minutes_late
        FROM day_scans d LEFT JOIN shift_config s ON s.id = d.shift_id
        ORDER BY d.check_in ASC NULLS LAST
      `, [date]);
      rows = r.rows; title = 'Daily Attendance Report'; isMonthly = false;
      filename = 'attendance_daily_' + date + '.pdf';
    } else {
      const r = await pool.query(`
        WITH day_scans AS (
          SELECT al.employee_id, e.firstname, e.lastname,
            MIN((${dn})) AS display_name,
            DATE(al.raw_event_time) AS work_date,
            MIN(al.raw_event_time) AS check_in, MAX(al.raw_event_time) AS last_scan,
            COUNT(*) AS total_scans, (${effShift}) AS shift_id
          FROM attendance_log al LEFT JOIN employeex e ON e.id = al.employee_id
          WHERE EXTRACT(YEAR FROM al.raw_event_time) = $1
            AND EXTRACT(MONTH FROM al.raw_event_time) = $2
          GROUP BY al.employee_id, e.firstname, e.lastname, DATE(al.raw_event_time)
        )
        SELECT TO_CHAR(d.work_date,'DD/MM/YYYY') AS work_date, d.employee_id,
          d.display_name AS name,
          TO_CHAR(d.check_in, 'HH24:MI') AS check_in,
          CASE WHEN d.total_scans > 1 THEN TO_CHAR(d.last_scan, 'HH24:MI') ELSE '—' END AS check_out,
          d.total_scans,
          CASE WHEN d.check_in IS NULL THEN 'ABSENT' WHEN d.check_in::TIME <= s.checkin_end THEN 'ON TIME' ELSE 'LATE' END AS checkin_status,
          CASE WHEN d.total_scans <= 1 THEN 'NOT OUT' WHEN d.last_scan::TIME < s.checkout_start THEN 'EARLY OUT' WHEN d.last_scan::TIME > s.checkout_end THEN 'LEFT LATE' ELSE 'ON TIME' END AS checkout_status
        FROM day_scans d LEFT JOIN shift_config s ON s.id = d.shift_id
        ORDER BY d.employee_id, d.work_date ASC
      `, [year, month]);
      rows = r.rows; isMonthly = true;
      const mName = new Date(year, month-1, 1).toLocaleString('default',{month:'long'});
      title = `Monthly Attendance Report — ${mName} ${year}`;
      filename = `attendance_monthly_${year}_${month.toString().padStart(2,'0')}.pdf`;
    }

    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    doc.pipe(res);

    const W = doc.page.width - 80;
    const statusColor = {
      'ON TIME':   [0, 165, 114],
      'LATE':      [212, 42, 74],
      'EARLY OUT': [201, 112, 0],
      'LEFT LATE': [153, 51, 255],
      'NOT OUT':   [107, 114, 128],
      'ABSENT':    [212, 42, 74],
    };

    // Header block
    doc.rect(40, 30, W, 50).fill([15, 20, 30]);
    doc.fillColor('white').font('Helvetica-Bold').fontSize(16).text(title, 50, 43);
    doc.font('Helvetica').fontSize(9).fillColor([150,160,175])
       .text('Generated: ' + new Date().toLocaleString(), 50, 65);
    doc.fillColor('black');

    // Table setup
    const cols = isMonthly
      ? [{h:'Date',w:70},{h:'ID',w:60},{h:'Name',w:110},{h:'In',w:45},{h:'Out',w:45},{h:'Scans',w:40},{h:'In Status',w:70},{h:'Out Status',w:70}]
      : [{h:'ID',w:70},{h:'Name',w:120},{h:'In',w:50},{h:'Out',w:50},{h:'Scans',w:40},{h:'In Status',w:80},{h:'Out Status',w:80},{h:'Min Late',w:55}];

    let y = 100;
    const rowH = 20;

    // Column headers
    doc.rect(40, y, W, rowH).fill([26, 35, 50]);
    let x = 40;
    cols.forEach(col => {
      doc.fillColor('white').font('Helvetica-Bold').fontSize(8)
         .text(col.h, x + 4, y + 6, { width: col.w - 8 });
      x += col.w;
    });
    y += rowH;

    // Data rows
    rows.forEach((row, i) => {
      if (y > doc.page.height - 60) {
        doc.addPage({ size:'A4', layout:'landscape', margin:40 });
        y = 40;
      }
      const bg = i % 2 === 0 ? [245, 247, 250] : [255, 255, 255];
      doc.rect(40, y, W, rowH).fill(bg);

      const vals = isMonthly
        ? [row.work_date, row.employee_id, row.name, row.check_in||'—', row.check_out||'—', row.total_scans, row.checkin_status, row.checkout_status]
        : [row.employee_id, row.name, row.check_in||'—', row.check_out||'—', row.total_scans, row.checkin_status, row.checkout_status, row.minutes_late > 0 ? '+'+row.minutes_late+'m' : '—'];

      x = 40;
      vals.forEach((val, vi) => {
        const col = cols[vi];
        const isStatus = (isMonthly && vi >= 6) || (!isMonthly && vi >= 5 && vi <= 6);
        if (isStatus) {
          const sc = statusColor[val] || [107,114,128];
          doc.rect(x+2, y+3, col.w-4, rowH-6).fill(sc);
          doc.fillColor('white').font('Helvetica-Bold').fontSize(7)
             .text(val||'', x+4, y+7, { width: col.w-8, align:'center' });
        } else {
          doc.fillColor([40,50,65]).font('Helvetica').fontSize(8)
             .text(String(val||''), x+4, y+6, { width: col.w-8 });
        }
        x += col.w;
      });
      y += rowH;
    });

    // Footer
    doc.rect(40, doc.page.height - 40, W, 20).fill([240,242,245]);
    doc.fillColor([100,110,125]).font('Helvetica').fontSize(8)
       .text(`SmartPay Attendance System  |  Total records: ${rows.length}`, 50, doc.page.height - 33);

    doc.end();
  } catch (err) {
    console.error('PDF export error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── SERVE DASHBOARD ───────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Poller (attlog → attendance_log) — same lifecycle as this server ──
let pollerChild = null;

function startPollerWithServer() {
  const off = process.env.DISABLE_POLLER === '1' || process.env.DISABLE_POLLER === 'true';
  if (off) {
    console.log('[poller] skipped (set DISABLE_POLLER=1 to run dashboard only)');
    return;
  }
  const pollerPath = path.join(__dirname, 'poller.js');
  pollerChild = fork(pollerPath, [], {
    cwd: __dirname,
    env: process.env,
    silent: false,
  });
  pollerChild.on('error', (err) => {
    console.error('[poller] spawn error:', err.message);
  });
  pollerChild.on('exit', (code, signal) => {
    pollerChild = null;
    if (signal) {
      console.log(`[poller] stopped (signal ${signal})`);
    } else {
      console.log(`[poller] process exited (code ${code})`);
    }
  });
  console.log('[poller] started alongside server (pid ' + pollerChild.pid + ')');
}

function stopPollerChild() {
  if (!pollerChild || pollerChild.killed) return;
  try {
    pollerChild.kill('SIGTERM');
  } catch (e) {
    console.error('[poller] kill:', e.message);
  }
}

function shutdown() {
  stopPollerChild();
  process.exit(0);
}

process.on('SIGINT', () => {
  console.log('\n[server] SIGINT — shutting down');
  shutdown();
});
process.on('SIGTERM', () => {
  console.log('[server] SIGTERM — shutting down');
  shutdown();
});

app.listen(PORT, async () => {
  console.log(`🚀 SmartPay Dashboard running on http://localhost:${PORT}`);
  try {
    await ensureSmartpaySettingsTable();
    console.log('[settings] default shift key ready');
  } catch (e) {
    console.error('[settings]', e.message);
  }
  startPollerWithServer();
});
