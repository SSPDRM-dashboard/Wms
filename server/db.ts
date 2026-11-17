import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';

const rawDbPath = process.env.WMS_DB_PATH;
const dbPath =
  rawDbPath && (rawDbPath.includes('/') || rawDbPath.includes('.'))
    ? rawDbPath
    : './data/wms.sqlite';
const resolvedDbPath = path.resolve(dbPath);
fs.mkdirSync(path.dirname(resolvedDbPath), { recursive: true });

export const db = new DatabaseSync(resolvedDbPath);

db.exec('PRAGMA journal_mode = DELETE;');
db.exec('PRAGMA synchronous = FULL;');
db.exec('PRAGMA foreign_keys = ON;');

export function initDatabase(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      qr_profile TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'supervisor', 'operator')),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS containers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      container_code TEXT NOT NULL,
      pallet_ref TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL,
      total_boxes INTEGER NOT NULL DEFAULT 0,
      total_units INTEGER NOT NULL DEFAULT 0,
      received_by TEXT NOT NULL,
      completed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS inventory_lots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      part_number TEXT NOT NULL,
      qty INTEGER NOT NULL CHECK (qty >= 0),
      initial_qty INTEGER NOT NULL CHECK (initial_qty > 0),
      box_id TEXT NOT NULL,
      batch_ref TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL,
      container_id INTEGER REFERENCES containers(id),
      pallet_ref TEXT NOT NULL DEFAULT '',
      received_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_lots_fifo
      ON inventory_lots(company_id, part_number, received_at, id);

    CREATE TABLE IF NOT EXISTS movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      movement_type TEXT NOT NULL CHECK (movement_type IN ('RECEIVE', 'OUTBOUND_FIFO', 'TRANSFER')),
      part_number TEXT NOT NULL,
      qty_delta INTEGER NOT NULL,
      box_id TEXT NOT NULL DEFAULT '',
      batch_ref TEXT NOT NULL DEFAULT '',
      from_location TEXT NOT NULL DEFAULT '',
      to_location TEXT NOT NULL DEFAULT '',
      reference_code TEXT NOT NULL DEFAULT '',
      lot_id INTEGER,
      performed_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_movements_company_date
      ON movements(company_id, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS boms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      parent_part TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      revision TEXT NOT NULL DEFAULT 'A',
      created_by TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(company_id, parent_part)
    );

    CREATE TABLE IF NOT EXISTS bom_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bom_id INTEGER NOT NULL REFERENCES boms(id) ON DELETE CASCADE,
      component_part TEXT NOT NULL,
      qty_per_assembly INTEGER NOT NULL CHECK (qty_per_assembly > 0),
      notes TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS uploaded_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      file_name TEXT NOT NULL,
      row_count INTEGER NOT NULL DEFAULT 0,
      uploaded_by TEXT NOT NULL,
      uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS uploaded_file_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL REFERENCES uploaded_files(id) ON DELETE CASCADE,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      lookup_key TEXT NOT NULL,
      part_name TEXT NOT NULL DEFAULT '',
      part_number TEXT NOT NULL,
      qty INTEGER NOT NULL DEFAULT 1,
      batch_ref TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_uploaded_rows_lookup
      ON uploaded_file_rows(company_id, lookup_key);
  `);

  seedInitialData();
}

function seedInitialData(): void {
  const companyCount = db.prepare('SELECT COUNT(*) AS cnt FROM companies').get() as { cnt: number };
  if (companyCount.cnt === 0) {
    const insertCompany = db.prepare(
      'INSERT INTO companies (code, name, qr_profile, description) VALUES (?, ?, ?, ?)'
    );
    insertCompany.run(
      'COMP-B-SAIC',
      'COMP-B-SAIC',
      'underscore_v1',
      'Underscore-delimited QR profile: seg 2 = part, seg 4 = qty, seg 5 = box, seg 6 = batch'
    );
    insertCompany.run(
      'COMP-A-GWM',
      'COMP-A-GWM',
      'slash_box_pallet_v1',
      'Slash-delimited box QR (seg 2 = part&qty, seg 3 = batch, seg 4 = box) + pallet reference QR'
    );
  } else {
    const existingCompanies = db
      .prepare('SELECT id, code, name FROM companies WHERE id IN (1, 2)')
      .all() as Array<{ id: number; code: string; name: string }>;
    const c1 = existingCompanies.find((c) => c.id === 1);
    const c2 = existingCompanies.find((c) => c.id === 2);
    if (
      c1 &&
      c2 &&
      (c1.code !== 'COMP-B-SAIC' ||
        c1.name !== 'COMP-B-SAIC' ||
        c2.code !== 'COMP-A-GWM' ||
        c2.name !== 'COMP-A-GWM')
    ) {
      db.exec('BEGIN IMMEDIATE;');
      try {
        db.prepare('UPDATE companies SET code = ?, name = ? WHERE id = 1').run(
          '__SWAP_TMP_1__',
          'COMP-B-SAIC'
        );
        db.prepare('UPDATE companies SET code = ?, name = ? WHERE id = 2').run(
          'COMP-A-GWM',
          'COMP-A-GWM'
        );
        db.prepare('UPDATE companies SET code = ?, name = ? WHERE id = 1').run(
          'COMP-B-SAIC',
          'COMP-B-SAIC'
        );
        db.exec('COMMIT;');
      } catch (err) {
        try {
          db.exec('ROLLBACK;');
        } catch {
          // ignore rollback error
        }
        throw err;
      }
    }
  }

  const userCount = db.prepare('SELECT COUNT(*) AS cnt FROM users').get() as { cnt: number };
  if (userCount.cnt === 0) {
    const rawAdminUser = process.env.ADMIN_USERNAME;
    const rawAdminPass = process.env.ADMIN_PASSWORD;
    const adminUsername =
      rawAdminUser && !/^\d+$/.test(rawAdminUser) ? rawAdminUser : 'admin';
    const adminPassword =
      rawAdminPass && !/^\d+$/.test(rawAdminPass) ? rawAdminPass : 'ChangeMe-Immediately-123!';

    const insertUser = db.prepare(
      'INSERT INTO users (username, full_name, password_hash, role, active) VALUES (?, ?, ?, ?, 1)'
    );
    insertUser.run(adminUsername, 'System Administrator', bcrypt.hashSync(adminPassword, 10), 'admin');
    insertUser.run('supervisor', 'Elena Vance', bcrypt.hashSync('Supervisor-123!', 10), 'supervisor');
    insertUser.run('operator', 'Marcus Chen', bcrypt.hashSync('Operator-123!', 10), 'operator');
  }
}
