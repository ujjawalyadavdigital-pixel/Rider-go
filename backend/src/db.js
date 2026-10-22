import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(file = process.env.DB_FILE || './data/ridergo.db') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS riders (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      phone         TEXT NOT NULL UNIQUE,
      name          TEXT,
      rider_code    TEXT NOT NULL UNIQUE,
      vehicle       TEXT NOT NULL DEFAULT 'Motorbike',
      status        TEXT NOT NULL DEFAULT 'new',      -- new | pending_review | active
      online        INTEGER NOT NULL DEFAULT 0,
      online_since  INTEGER,
      cash_in_hand  INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS otps (
      phone      TEXT PRIMARY KEY,
      code_hash  TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0,
      sent_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      rider_id   INTEGER NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS documents (
      rider_id    INTEGER NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
      type        TEXT NOT NULL,                      -- id | dl | rc | selfie | bank
      status      TEXT NOT NULL,                      -- pending | verified | rejected
      file_name   TEXT,
      uploaded_at INTEGER NOT NULL,
      verified_at INTEGER,
      PRIMARY KEY (rider_id, type)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      public_id      TEXT NOT NULL UNIQUE,
      rider_id       INTEGER NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
      status         TEXT NOT NULL,   -- offered|accepted|at_restaurant|verified|picked_up|at_customer|delivered|settled|declined|expired
      restaurant     TEXT NOT NULL,
      rest_address   TEXT NOT NULL,
      customer_name  TEXT NOT NULL,
      customer_area  TEXT NOT NULL,
      customer_addr  TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      delivery_note  TEXT,
      items_json     TEXT NOT NULL,
      order_value    INTEGER NOT NULL,
      payment_type   TEXT NOT NULL,   -- cod | prepaid
      km_to_rest     REAL NOT NULL,
      km_to_cust     REAL NOT NULL,
      min_to_rest    INTEGER NOT NULL,
      min_to_cust    INTEGER NOT NULL,
      pickup_code    TEXT NOT NULL,
      drop_otp       TEXT NOT NULL,
      cash_collected INTEGER NOT NULL DEFAULT 0,
      offered_at     INTEGER NOT NULL,
      expires_at     INTEGER NOT NULL,
      accepted_at    INTEGER,
      arrived_rest_at INTEGER,
      picked_up_at   INTEGER,
      delivered_at   INTEGER,
      settled_at     INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_orders_rider ON orders(rider_id, status);

    CREATE TABLE IF NOT EXISTS earning_lines (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id  INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      rider_id  INTEGER NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
      label     TEXT NOT NULL,
      amount    INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_earn_rider ON earning_lines(rider_id, created_at);

    CREATE TABLE IF NOT EXISTS messages (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id  INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      body      TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shifts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      rider_id    INTEGER NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
      started_at  INTEGER NOT NULL,
      ended_at    INTEGER,
      deliveries  INTEGER NOT NULL DEFAULT 0,
      earnings    INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}
