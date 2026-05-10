/**
 * Extended tables for payment queue + SMS logging. Safe to run repeatedly.
 */
async function ensureSmartpayExtendedTables(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS payment_queue (
      employee_id TEXT NOT NULL,
      event_date DATE NOT NULL,
      checkout_time TIMESTAMP WITHOUT TIME ZONE,
      status TEXT NOT NULL DEFAULT 'PENDING',
      compliant BOOLEAN NOT NULL DEFAULT FALSE,
      amount NUMERIC(12, 2),
      sms_log_id UUID,
      PRIMARY KEY (employee_id, event_date)
    )
  `);

  await client.query(`
    ALTER TABLE payment_queue ADD COLUMN IF NOT EXISTS compliant BOOLEAN NOT NULL DEFAULT FALSE
  `);
  await client.query(`
    ALTER TABLE payment_queue ADD COLUMN IF NOT EXISTS amount NUMERIC(12, 2)
  `);
  await client.query(`
    ALTER TABLE payment_queue ADD COLUMN IF NOT EXISTS sms_log_id UUID
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS sms_log (
      id UUID PRIMARY KEY,
      employee_id TEXT NOT NULL,
      work_date DATE NOT NULL,
      phone TEXT,
      message_body TEXT,
      daily_rate_snapshot NUMERIC(12, 2),
      textify_message_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      provider_error TEXT,
      raw_response JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (employee_id, work_date)
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS sms_log_work_date_idx ON sms_log (work_date DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS sms_log_textify_id_idx ON sms_log (textify_message_id)
  `);
}

module.exports = { ensureSmartpayExtendedTables };
