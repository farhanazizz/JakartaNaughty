/**
 * ============================================================
 * src/services/creditService.js — Manajemen Kredit
 * ============================================================
 * Semua operasi kredit terpusat di sini dengan jaminan atomicity
 * menggunakan SQLite transaction. Ini memastikan tidak ada race
 * condition (misalnya 2 generate bersamaan memakai kredit yang sama).
 *
 * PENTING: Saldo kredit HANYA bisa diubah lewat fungsi di file ini.
 * Tidak ada route API yang bisa langsung mengubah kolom 'credits' di DB.
 * ============================================================
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../config/database');
const { logger } = require('../utils/logger');

/**
 * Mengurangi kredit user secara atomic.
 * Menggunakan SQLite transaction untuk mencegah race condition.
 *
 * Alur:
 *  1. BEGIN TRANSACTION
 *  2. SELECT kredit dengan lock (FOR UPDATE tidak ada di SQLite, tapi
 *     better-sqlite3 synchronous sudah thread-safe)
 *  3. Cek apakah kredit cukup
 *  4. UPDATE kredit
 *  5. INSERT ke credit_logs
 *  6. COMMIT
 *
 * @param {string} userId  - ID user
 * @param {number} amount  - Jumlah kredit yang dikurangi (harus positif)
 * @param {string} reason  - Alasan pengurangan (untuk log)
 * @returns {{ success: boolean, newBalance: number, message?: string }}
 */
function deductCredit(userId, amount, reason) {
  const db = getDb();

  // Jalankan dalam transaction untuk atomicity
  const transaction = db.transaction(() => {
    // Ambil saldo saat ini (dengan lock implicit dari transaction)
    const user = db.prepare(
      'SELECT credits FROM users WHERE id = ? AND is_active = 1'
    ).get(userId);

    // Validasi user ada dan aktif
    if (!user) {
      return { success: false, message: 'User tidak ditemukan atau tidak aktif' };
    }

    // Validasi kredit cukup
    if (user.credits < amount) {
      return {
        success: false,
        message: `Kredit tidak cukup. Saldo: ${user.credits}, dibutuhkan: ${amount}`,
        newBalance: user.credits,
      };
    }

    const balanceBefore = user.credits;
    const balanceAfter = balanceBefore - amount;

    // Kurangi kredit
    db.prepare(
      'UPDATE users SET credits = ? WHERE id = ?'
    ).run(balanceAfter, userId);

    // Catat di credit_logs untuk audit trail
    db.prepare(`
      INSERT INTO credit_logs (id, user_id, amount_changed, balance_before, balance_after, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      userId,
      -amount,        // Negatif karena pengurangan
      balanceBefore,
      balanceAfter,
      reason,
      new Date().toISOString()
    );

    logger.debug(`Kredit dikurangi: user=${userId} -${amount} | saldo: ${balanceBefore}→${balanceAfter}`);

    return { success: true, newBalance: balanceAfter };
  });

  // Jalankan transaction
  return transaction();
}

/**
 * Menambah kredit user.
 * HANYA boleh dipanggil dari admin routes!
 * Semua penambahan kredit dicatat dengan ID admin yang melakukan.
 *
 * @param {string} userId      - ID user yang kreditnya ditambah
 * @param {number} amount      - Jumlah kredit yang ditambah (harus positif)
 * @param {string} reason      - Alasan penambahan
 * @param {string} adminId     - ID admin yang melakukan penambahan
 * @returns {{ success: boolean, newBalance: number }}
 */
function addCredit(userId, amount, reason, adminId) {
  const db = getDb();

  const transaction = db.transaction(() => {
    // Ambil saldo saat ini
    const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(userId);

    if (!user) {
      return { success: false, message: 'User tidak ditemukan' };
    }

    const balanceBefore = user.credits;
    const balanceAfter = balanceBefore + amount;

    // Update saldo
    db.prepare('UPDATE users SET credits = ? WHERE id = ?').run(balanceAfter, userId);

    // Catat di credit_logs
    db.prepare(`
      INSERT INTO credit_logs (id, user_id, amount_changed, balance_before, balance_after, reason, changed_by_admin_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      userId,
      amount,         // Positif karena penambahan
      balanceBefore,
      balanceAfter,
      reason,
      adminId,
      new Date().toISOString()
    );

    logger.info(`Kredit ditambah: user=${userId} +${amount} by admin=${adminId} | saldo: ${balanceBefore}→${balanceAfter}`);

    return { success: true, newBalance: balanceAfter };
  });

  return transaction();
}

/**
 * Mendapatkan saldo kredit user saat ini.
 *
 * @param {string} userId - ID user
 * @returns {number} Saldo kredit (0 jika user tidak ditemukan)
 */
function getBalance(userId) {
  const db = getDb();
  const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(userId);
  return user?.credits ?? 0;
}

/**
 * Mendapatkan history perubahan kredit user.
 *
 * @param {string} userId         - ID user
 * @param {number} [limit=20]     - Jumlah record yang diambil
 * @param {number} [offset=0]     - Offset untuk pagination
 * @returns {Array} List perubahan kredit
 */
function getCreditHistory(userId, limit = 20, offset = 0) {
  const db = getDb();
  return db.prepare(`
    SELECT
      cl.*,
      u.email AS admin_email
    FROM credit_logs cl
    LEFT JOIN users u ON cl.changed_by_admin_id = u.id
    WHERE cl.user_id = ?
    ORDER BY cl.created_at DESC
    LIMIT ? OFFSET ?
  `).all(userId, limit, offset);
}

module.exports = { deductCredit, addCredit, getBalance, getCreditHistory };
