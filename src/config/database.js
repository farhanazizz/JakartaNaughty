/**
 * ============================================================
 * src/config/database.js — Setup Database SQLite (Pure JS / WASM)
 * ============================================================
 * Menggunakan sql.js (WebAssembly SQLite) yang 100% portable,
 * tidak memerlukan build tools / compiler C++ (Visual Studio).
 * Database disimpan secara persisten ke file `krea2.db` di root project.
 *
 * Menyediakan API synchronous yang kompatibel:
 *   - db.prepare(sql).get(...params)
 *   - db.prepare(sql).all(...params)
 *   - db.prepare(sql).run(...params)
 *   - db.exec(sql)
 *   - db.transaction(fn)
 *   - db.pragma(sql)
 *
 * Export:
 *   - getDb()  → return instance database yang sudah siap
 *   - initDb() → inisialisasi WASM runtime, load DB dari file, & migrasi tabel
 *   - closeDb() → simpan ke disk dan tutup database
 * ============================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { logger } = require('../utils/logger');

// Path file database SQLite (Prioritaskan: env DB_PATH -> folder data/krea2.db -> root krea2.db)
function resolveDbPath() {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  
  const dataDb = path.join(process.cwd(), 'data', 'krea2.db');
  const rootDb = path.join(process.cwd(), 'krea2.db');
  
  if (fs.existsSync(dataDb)) return dataDb;
  if (fs.existsSync(rootDb)) return rootDb;
  
  return dataDb;
}

const DB_PATH = resolveDbPath();

// Raw sql.js Database instance & wrapper singleton
let rawDb = null;
let dbWrapper = null;
let inTransaction = false;

/**
 * Menyimpan snapshot database di memory ke file `krea2.db` secara persisten.
 */
function persistToDisk() {
  if (!rawDb || inTransaction) return;
  try {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const data = rawDb.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (err) {
    logger.error('Gagal menyimpan database ke disk:', err.message);
  }
}


/**
 * Class Statement untuk membungkus query prepared statement sql.js
 * agar kompatibel dengan API better-sqlite3 (.get, .all, .run).
 */
class PreparedStatement {
  /**
   * @param {string} sql
   */
  constructor(sql) {
    this.sql = sql;
  }

  /**
   * Normalisasi parameter (bisa (...args) atau ([...args]))
   * @private
   */
  _normalizeParams(params) {
    if (params.length === 1 && Array.isArray(params[0])) {
      return params[0];
    }
    return params;
  }

  /**
   * Mengambil 1 baris hasil query (SELECT).
   * @param  {...any} params Parameter query
   * @returns {Object|undefined} Baris objek kolom atau undefined jika kosong
   */
  get(...params) {
    const p = this._normalizeParams(params);
    const stmt = rawDb.prepare(this.sql);
    if (p.length > 0) stmt.bind(p);

    let result = undefined;
    if (stmt.step()) {
      result = stmt.getAsObject();
    }
    stmt.free();
    return result;
  }

  /**
   * Mengambil semua baris hasil query (SELECT).
   * @param  {...any} params Parameter query
   * @returns {Array<Object>} List baris objek kolom
   */
  all(...params) {
    const p = this._normalizeParams(params);
    const stmt = rawDb.prepare(this.sql);
    if (p.length > 0) stmt.bind(p);

    const results = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  }

  /**
   * Mengeksekusi query modifikasi (INSERT, UPDATE, DELETE).
   * Otomatis menyimpan perubahan ke disk.
   * @param  {...any} params Parameter query
   * @returns {{ changes: number, lastInsertRowid: any }}
   */
  run(...params) {
    const p = this._normalizeParams(params);
    rawDb.run(this.sql, p);
    persistToDisk();

    return {
      changes: rawDb.getRowsModified(),
      lastInsertRowid: undefined,
    };
  }
}

/**
 * Inisialisasi runtime Database sql.js dan migrasi tabel-tabel.
 * Dipanggil saat startup server (async).
 */
async function initDb() {
  if (dbWrapper) return dbWrapper;

  const SQL = await initSqlJs();

  // Load database yang ada dari disk jika file krea2.db sudah ada
  if (fs.existsSync(DB_PATH)) {
    try {
      const fileBuffer = fs.readFileSync(DB_PATH);
      rawDb = new SQL.Database(fileBuffer);
      logger.info(`Database SQLite dimuat dari file: ${DB_PATH}`);
    } catch (err) {
      logger.warn(`Gagal membaca file DB yang ada (${err.message}), membuat DB baru.`);
      rawDb = new SQL.Database();
    }
  } else {
    rawDb = new SQL.Database();
    logger.info(`Database SQLite baru dibuat: ${DB_PATH}`);
  }

  // Buat DB wrapper
  dbWrapper = {
    /**
     * Membuat prepared statement
     * @param {string} sql
     */
    prepare(sql) {
      return new PreparedStatement(sql);
    },

    /**
     * Mengeksekusi string SQL langsung
     * @param {string} sql
     */
    exec(sql) {
      rawDb.run(sql);
      persistToDisk();
    },

    /**
     * Eksekusi PRAGMA
     * @param {string} pragmaSql
     */
    pragma(pragmaSql) {
      try {
        rawDb.run(`PRAGMA ${pragmaSql};`);
      } catch {
        // Ignored in sql.js
      }
    },

    /**
     * Membungkus fungsi dalam transaksi database (atomic)
     * @param {Function} fn
     */
    transaction(fn) {
      return function (...args) {
        inTransaction = true;
        rawDb.run('BEGIN TRANSACTION;');
        try {
          const result = fn(...args);
          rawDb.run('COMMIT;');
          inTransaction = false;
          persistToDisk();
          return result;
        } catch (err) {
          try {
            rawDb.run('ROLLBACK;');
          } catch {
            // Abaikan jika rollback gagal
          }
          inTransaction = false;
          throw err;
        }
      };
    },
  };

  // -------------------------------------------------------
  // Migrasi / Schema Database
  // -------------------------------------------------------

  // Tabel: users
  dbWrapper.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id              TEXT PRIMARY KEY,
      email           TEXT UNIQUE NOT NULL,
      password_hash   TEXT NOT NULL,
      role            TEXT NOT NULL DEFAULT 'user',
      credits         INTEGER NOT NULL DEFAULT 0,
      is_active       INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT NOT NULL,
      last_login_at   TEXT,
      login_fail_count INTEGER NOT NULL DEFAULT 0,
      locked_until    TEXT
    );
  `);

  // Tabel: refresh_tokens
  dbWrapper.exec(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      token_hash  TEXT UNIQUE NOT NULL,
      expires_at  TEXT NOT NULL,
      revoked_at  TEXT,
      created_at  TEXT NOT NULL,
      ip_address  TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // Tabel: jobs
  dbWrapper.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id                  TEXT PRIMARY KEY,
      user_id             TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'pending',
      source_image_name   TEXT,
      source_image_path   TEXT,
      positive_prompt     TEXT NOT NULL,
      negative_prompt     TEXT,
      seed                INTEGER,
      ref_boost           REAL DEFAULT 4.2,
      steps               INTEGER,
      gpu_instance_id     TEXT,
      gpu_instance_url    TEXT,
      comfyui_prompt_id   TEXT,
      output_filename     TEXT,
      credits_used        INTEGER NOT NULL DEFAULT 1,
      resolution          TEXT NOT NULL DEFAULT '1mp',
      error_message       TEXT,
      created_at          TEXT NOT NULL,
      started_at          TEXT,
      completed_at        TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // Migrasi aman untuk database yang sudah ada
  try {
    dbWrapper.exec('ALTER TABLE jobs ADD COLUMN ref_boost REAL DEFAULT 4.2;');
  } catch (_) {
    // Abaikan jika kolom sudah ada
  }

  try {
    dbWrapper.exec("ALTER TABLE jobs ADD COLUMN resolution TEXT DEFAULT '1mp';");
  } catch (_) {
    // Abaikan jika kolom sudah ada
  }

  // Tabel: gpu_settings (Manajemen Status & Mode Armada GPU)
  dbWrapper.exec(`
    CREATE TABLE IF NOT EXISTS gpu_settings (
      gpu_id      TEXT PRIMARY KEY,
      is_enabled  INTEGER NOT NULL DEFAULT 1,
      mode        TEXT NOT NULL DEFAULT 'public', -- 'public', 'test_only', 'disabled'
      label       TEXT,
      updated_at  TEXT NOT NULL
    );
  `);




  // Tabel: credit_logs
  dbWrapper.exec(`
    CREATE TABLE IF NOT EXISTS credit_logs (
      id                  TEXT PRIMARY KEY,
      user_id             TEXT NOT NULL,
      amount_changed      INTEGER NOT NULL,
      balance_before      INTEGER NOT NULL,
      balance_after       INTEGER NOT NULL,
      reason              TEXT NOT NULL,
      changed_by_admin_id TEXT,
      created_at          TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // Tabel: audit_logs
  dbWrapper.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id              TEXT PRIMARY KEY,
      admin_id        TEXT NOT NULL,
      action          TEXT NOT NULL,
      target_user_id  TEXT,
      detail          TEXT,
      ip_address      TEXT,
      user_agent      TEXT,
      created_at      TEXT NOT NULL
    );
  `);

  // Tabel: security_logs (Pantau aktivitas mencurigakan, IP, dan User-Agent)
  dbWrapper.exec(`
    CREATE TABLE IF NOT EXISTS security_logs (
      id          TEXT PRIMARY KEY,
      username    TEXT,
      event       TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'INFO', -- 'SUCCESS', 'WARNING', 'DANGER', 'INFO'
      ip_address  TEXT,
      user_agent  TEXT,
      detail      TEXT,
      created_at  TEXT NOT NULL
    );
  `);

  // Index
  dbWrapper.exec(`
    CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs(user_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
    CREATE INDEX IF NOT EXISTS idx_credit_logs_user_id ON credit_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_security_logs_created ON security_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_security_logs_ip ON security_logs(ip_address);
  `);

  logger.info('Database diinisialisasi — semua tabel siap (Pure JS/WASM SQLite)');
  return dbWrapper;
}

/**
 * Mendapatkan instance database yang sudah diinisialisasi.
 * @returns {Object} Database wrapper
 */
function getDb() {
  if (!dbWrapper) {
    throw new Error('Database belum diinisialisasi! Panggil await initDb() terlebih dahulu.');
  }
  return dbWrapper;
}

/**
 * Menutup koneksi database dan memastikan data tersimpan.
 */
function closeDb() {
  if (rawDb) {
    persistToDisk();
    rawDb.close();
    rawDb = null;
    dbWrapper = null;
    logger.info('Koneksi database ditutup dan data tersimpan.');
  }
}

module.exports = { getDb, initDb, closeDb };
