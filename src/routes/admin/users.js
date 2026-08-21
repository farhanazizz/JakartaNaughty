/**
 * ============================================================
 * src/routes/admin/users.js — Admin: Manajemen User (Full-Control)
 * ============================================================
 * Endpoints (semua butuh auth + role admin):
 *   GET    /api/admin/users                  — List semua user + search + pagination
 *   POST   /api/admin/users                  — Buat user baru manual
 *   GET    /api/admin/users/:userId          — Detail lengkap user + 10 job + log kredit
 *   PATCH  /api/admin/users/:userId/status   — Toggle aktif/nonaktif
 *   PATCH  /api/admin/users/:userId/suspend  — Suspend / Unsuspend user
 *   POST   /api/admin/users/:userId/reset-password — Reset password user
 *   DELETE /api/admin/users/:userId          — Hapus user (soft delete)
 * ============================================================
 */

'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../../config/database');
const { hashPassword } = require('../../utils/hash');
const { addCredit } = require('../../services/creditService');
const { logger } = require('../../utils/logger');

const router = express.Router();

// -------------------------------------------------------
// Helper: Catat audit log
// -------------------------------------------------------
function logAudit(adminId, action, targetUserId, detail, ip) {
  const db = getDb();
  db.prepare(`
    INSERT INTO audit_logs (id, admin_id, action, target_user_id, detail, ip_address, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuidv4(),
    adminId,
    action,
    targetUserId,
    typeof detail === 'string' ? detail : JSON.stringify(detail),
    ip,
    new Date().toISOString()
  );
}

// ============================================================
// GET /api/admin/users — List semua user
// ============================================================
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const search = req.query.search ? `%${req.query.search.trim().toLowerCase()}%` : '%';

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
      data: {
        users,
        pagination: {
          limit,
          offset,
          total: total.count,
        },
      },
    });
  } catch (err) {
    logger.error('List users error:', err.message);
    return res.status(500).json({ success: false, message: 'Gagal memuat daftar user.' });
  }
});

// ============================================================
// POST /api/admin/users — Buat user baru
// ============================================================
router.post('/', async (req, res) => {
  try {
    const identifier = (req.body.username || req.body.email || '').toLowerCase().trim();
    const { password, initial_credits } = req.body;

    // Validasi input
    if (!identifier || identifier.length < 3) {
      return res.status(400).json({ success: false, message: 'Username / Email minimal 3 karakter.' });
    }
    if (!password || typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password minimal 6 karakter.' });
    }

    const cleanEmail = identifier;
    const db = getDb();

    // Cek duplikasi username / email
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);
    if (existing) {
      return res.status(400).json({ success: false, message: 'Username / Email sudah terdaftar.' });
    }

    // Hash password
    const passwordHash = await hashPassword(password);
    const newUserId = uuidv4();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO users (id, email, password_hash, role, credits, is_active, created_at)
      VALUES (?, ?, ?, 'user', 0, 1, ?)
    `).run(newUserId, cleanEmail, passwordHash, now);

    // Tambah kredit awal jika diisi
    const initialCredits = Math.max(0, parseInt(initial_credits) || 0);
    if (initialCredits > 0) {
      addCredit(newUserId, initialCredits, 'Kredit awal pendaftaran akun', req.user.id);
    }

    logAudit(
      req.user.id,
      'CREATE_USER',
      newUserId,
      { email: cleanEmail, initial_credits: initialCredits },
      req.ip
    );

    logger.info(`Admin ${req.user.email} membuat user baru: ${cleanEmail} (kredit: ${initialCredits})`);

    const newUser = db.prepare(
      'SELECT id, email, role, credits, is_active, created_at FROM users WHERE id = ?'
    ).get(newUserId);

    return res.json({
      success: true,
      message: `User ${cleanEmail} berhasil dibuat.`,
      data: newUser,
    });
  } catch (err) {
    logger.error('Create user error:', err.message);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan saat membuat user.' });
  }
});

// ============================================================
// PATCH /api/admin/users/:userId/suspend — Suspend / Unsuspend User
// Status: 2 = Suspended, 1 = Aktif
// ============================================================
router.patch('/:userId/suspend', (req, res) => {
  try {
    const db = getDb();
    const userId = req.params.userId;
    const { suspend, reason } = req.body;

    const user = db.prepare('SELECT id, email, is_active, role FROM users WHERE id = ?').get(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User tidak ditemukan.' });
    }

    // Tidak boleh suspend admin
    if (user.role === 'admin') {
      return res.status(400).json({ success: false, message: 'Tidak bisa menangguhkan akun administrator.' });
    }

    // 2 = suspended, 1 = aktif
    const newStatus = suspend ? 2 : 1;
    db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(newStatus, userId);

    // Cabut semua refresh token user tersebut agar langsung logout
    if (suspend) {
      db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ?').run(
        new Date().toISOString(),
        userId
      );
    }

    const actionName = suspend ? 'SUSPEND_USER' : 'UNSUSPEND_USER';
    logAudit(req.user.id, actionName, userId, { email: user.email, reason: reason || '-' }, req.ip);

    logger.warn(`Admin ${req.user.email} ${actionName}: user=${user.email} reason=${reason || '-'}`);

    return res.json({
      success: true,
      message: suspend
        ? `Akun ${user.email} berhasil DITANGGUHKAN (SUSPENDED).`
        : `Akun ${user.email} berhasil DIAKTIFKAN kembali.`,
      data: { id: userId, is_active: newStatus },
    });
  } catch (err) {
    logger.error('Suspend user error:', err.message);
    return res.status(500).json({ success: false, message: 'Gagal mengubah status penangguhan akun.' });
  }
});

// ============================================================
// POST /api/admin/users/:userId/reset-password — Reset Password User
// ============================================================
router.post('/:userId/reset-password', async (req, res) => {
  try {
    const db = getDb();
    const userId = req.params.userId;
    const { new_password } = req.body;

    if (!new_password || typeof new_password !== 'string' || new_password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password baru minimal 6 karakter.' });
    }

    const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User tidak ditemukan.' });
    }

    const passwordHash = await hashPassword(new_password);
    db.prepare(`
      UPDATE users
      SET password_hash = ?, login_fail_count = 0, locked_until = NULL
      WHERE id = ?
    `).run(passwordHash, userId);

    // Cabut refresh token lama agar user login ulang dengan password baru
    db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ?').run(
      new Date().toISOString(),
      userId
    );

    logAudit(req.user.id, 'RESET_PASSWORD', userId, { email: user.email }, req.ip);
    logger.info(`Admin ${req.user.email} me-reset password user: ${user.email}`);

    return res.json({
      success: true,
      message: `Password akun ${user.email} berhasil diperbarui.`,
    });
  } catch (err) {
    logger.error('Reset password error:', err.message);
    return res.status(500).json({ success: false, message: 'Gagal memperbarui password user.' });
  }
});

// ============================================================
// GET /api/admin/users/:userId — Detail User
// ============================================================
router.get('/:userId', (req, res) => {
  try {
    const db = getDb();
    const userId = req.params.userId;

    const user = db.prepare(`
      SELECT id, email, role, credits, is_active, created_at, last_login_at
      FROM users WHERE id = ?
    `).get(userId);

    if (!user) {
      return res.status(404).json({ success: false, message: 'User tidak ditemukan.' });
    }

    const recentJobs = db.prepare(`
      SELECT id, status, positive_prompt, credits_used, created_at, completed_at
      FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 10
    `).all(userId);

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
  } catch (err) {
    logger.error('Get user detail error:', err.message);
    return res.status(500).json({ success: false, message: 'Gagal memuat detail user.' });
  }
});

// ============================================================
// PATCH /api/admin/users/:userId/status — Toggle Aktif/Nonaktif
// ============================================================
router.patch('/:userId/status', (req, res) => {
  try {
    const db = getDb();
    const userId = req.params.userId;
    const isActive = req.body.is_active ? 1 : 0;

    const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User tidak ditemukan.' });
    }

    db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(isActive, userId);

    logAudit(
      req.user.id,
      isActive ? 'ACTIVATE_USER' : 'DEACTIVATE_USER',
      userId,
      { email: user.email, is_active: isActive },
      req.ip
    );

    return res.json({
      success: true,
      message: `User ${user.email} berhasil ${isActive ? 'diaktifkan' : 'dinonaktifkan'}.`,
      data: { id: userId, is_active: isActive },
    });
  } catch (err) {
    logger.error('Status update error:', err.message);
    return res.status(500).json({ success: false, message: 'Gagal mengubah status user.' });
  }
});

// ============================================================
// DELETE /api/admin/users/:userId — Hapus User (Soft Delete)
// ============================================================
router.delete('/:userId', (req, res) => {
  try {
    const db = getDb();
    const userId = req.params.userId;

    const user = db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User tidak ditemukan.' });
    }
    if (user.role === 'admin') {
      return res.status(400).json({ success: false, message: 'Tidak bisa menghapus akun admin.' });
    }

    db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(userId);
    db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ?').run(
      new Date().toISOString(),
      userId
    );

    logAudit(req.user.id, 'DELETE_USER', userId, { email: user.email }, req.ip);

    return res.json({ success: true, message: `Akun ${user.email} berhasil dinonaktifkan/dihapus.` });
  } catch (err) {
    logger.error('Delete user error:', err.message);
    return res.status(500).json({ success: false, message: 'Gagal menghapus user.' });
  }
});

module.exports = { router, logAudit };
