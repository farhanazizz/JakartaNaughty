/**
 * ============================================================
 * src/routes/admin/users.js — Admin: Manajemen User
 * ============================================================
 * Endpoints (semua butuh auth + role admin):
 *   GET    /api/admin/users            — List semua user
 *   POST   /api/admin/users            — Buat user baru
 *   GET    /api/admin/users/:userId    — Detail user
 *   PATCH  /api/admin/users/:userId/status — Toggle aktif/nonaktif
 *   DELETE /api/admin/users/:userId    — Nonaktifkan user
 * ============================================================
 */

'use strict';

const express  = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../../config/database');
const { hashPassword } = require('../../utils/hash');
const { addCredit } = require('../../services/creditService');
const { logger } = require('../../utils/logger');

const router = express.Router();

// -------------------------------------------------------
// Helper: Catat audit log
// -------------------------------------------------------

/**
 * Menyimpan log aksi admin ke tabel audit_logs.
 * Dipanggil setelah setiap aksi penting oleh admin.
 *
 * @param {string} adminId      - ID admin yang melakukan aksi
 * @param {string} action       - Kode aksi (misal: CREATE_USER)
 * @param {string} targetUserId - ID user yang terdampak (boleh null)
 * @param {string} detail       - Detail aksi dalam string
 * @param {string} ip           - IP address admin
 */
function logAudit(adminId, action, targetUserId, detail, ip) {
  const db = getDb();
  db.prepare(`
    INSERT INTO audit_logs (id, admin_id, action, target_user_id, detail, ip_address, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuidv4(), adminId, action, targetUserId, detail, ip, new Date().toISOString()
  );
}

// ============================================================
// GET /api/admin/users — List semua user
// ============================================================
router.get('/', (req, res) => {
  const db     = getDb();
  const limit  = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = parseInt(req.query.offset) || 0;

  // Search by email (opsional)
  const search = req.query.search ? `%${req.query.search}%` : '%';

  const users = db.prepare(`
    SELECT
      id, email, role, credits, is_active,
      created_at, last_login_at, login_fail_count
    FROM users
    WHERE email LIKE ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(search, limit, offset);

  const total = db.prepare(
    'SELECT COUNT(*) as count FROM users WHERE email LIKE ?'
  ).get(search);

  return res.json({
    success: true,
    data: { users, pagination: { limit, offset, total: total.count } },
  });
});

// ============================================================
// POST /api/admin/users — Buat user baru
// ============================================================
router.post('/', async (req, res) => {
  try {
    const { email, password, initial_credits } = req.body;

    // Validasi input
    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, message: 'Email tidak valid.' });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ success: false, message: 'Password minimal 8 karakter.' });
    }

    const db = getDb();

    // Cek email sudah ada atau belum
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
    if (existing) {
      return res.status(400).json({ success: false, message: 'Email sudah terdaftar.' });
    }

    // Hash password
    const passwordHash = await hashPassword(password);

    // Buat user baru
    const newUserId = uuidv4();
    db.prepare(`
      INSERT INTO users (id, email, password_hash, role, credits, is_active, created_at)
      VALUES (?, ?, ?, 'user', 0, 1, ?)
    `).run(newUserId, email.toLowerCase().trim(), passwordHash, new Date().toISOString());

    // Tambah kredit awal jika ada
    const initialCredits = parseInt(initial_credits) || 0;
    if (initialCredits > 0) {
      addCredit(newUserId, initialCredits, 'Kredit awal saat pembuatan akun', req.user.id);
    }

    // Catat audit log
    logAudit(
      req.user.id,
      'CREATE_USER',
      newUserId,
      JSON.stringify({ email, initial_credits: initialCredits }),
      req.ip
    );

    logger.info(`Admin ${req.user.id} membuat user baru: ${email}`);

    // Ambil data user yang baru dibuat
    const newUser = db.prepare(
      'SELECT id, email, role, credits, is_active, created_at FROM users WHERE id = ?'
    ).get(newUserId);

    return res.json({ success: true, data: newUser });

  } catch (err) {
    logger.error('Create user error:', err.message);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
});

// ============================================================
// GET /api/admin/users/:userId — Detail user
// ============================================================
router.get('/:userId', (req, res) => {
  const db     = getDb();
  const userId = req.params.userId;

  const user = db.prepare(`
    SELECT id, email, role, credits, is_active, created_at, last_login_at
    FROM users WHERE id = ?
  `).get(userId);

  if (!user) {
    return res.status(404).json({ success: false, message: 'User tidak ditemukan.' });
  }

  // Ambil 10 job terakhir user ini
  const recentJobs = db.prepare(`
    SELECT id, status, positive_prompt, credits_used, created_at, completed_at
    FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 10
  `).all(userId);

  // Ambil 10 log kredit terakhir
  const creditLogs = db.prepare(`
    SELECT cl.*, u.email as admin_email
    FROM credit_logs cl
    LEFT JOIN users u ON cl.changed_by_admin_id = u.id
    WHERE cl.user_id = ? ORDER BY cl.created_at DESC LIMIT 10
  `).all(userId);

  return res.json({
    success: true,
    data: { user, recentJobs, creditLogs },
  });
});

// ============================================================
// PATCH /api/admin/users/:userId/status — Toggle aktif/nonaktif
// ============================================================
router.patch('/:userId/status', (req, res) => {
  const db       = getDb();
  const userId   = req.params.userId;
  const isActive = req.body.is_active ? 1 : 0;

  // Cek user ada
  const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(userId);
  if (!user) {
    return res.status(404).json({ success: false, message: 'User tidak ditemukan.' });
  }

  db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(isActive, userId);

  // Catat audit log
  logAudit(
    req.user.id,
    isActive ? 'ACTIVATE_USER' : 'DEACTIVATE_USER',
    userId,
    JSON.stringify({ email: user.email, is_active: isActive }),
    req.ip
  );

  logger.info(`Admin ${req.user.id} ${isActive ? 'aktifkan' : 'nonaktifkan'} user ${userId}`);

  return res.json({
    success: true,
    message: `User berhasil ${isActive ? 'diaktifkan' : 'dinonaktifkan'}.`,
  });
});

// ============================================================
// DELETE /api/admin/users/:userId — Nonaktifkan user (soft delete)
// ============================================================
router.delete('/:userId', (req, res) => {
  const db     = getDb();
  const userId = req.params.userId;

  const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(userId);
  if (!user) {
    return res.status(404).json({ success: false, message: 'User tidak ditemukan.' });
  }

  // Soft delete — set is_active = 0, data tidak dihapus
  db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(userId);

  logAudit(req.user.id, 'DELETE_USER', userId, JSON.stringify({ email: user.email }), req.ip);

  return res.json({ success: true, message: 'User berhasil dinonaktifkan.' });
});

module.exports = { router, logAudit };
