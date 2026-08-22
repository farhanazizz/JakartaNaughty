/**
 * ============================================================
 * src/routes/admin/index.js — Admin: Router Aggregator + Dashboard
 * ============================================================
 * File ini:
 *  1. Menggabungkan semua sub-router admin
 *  2. Menerapkan middleware auth + role admin ke semua routes
 *  3. Menyediakan endpoint dashboard stats & security logs
 * ============================================================
 */

'use strict';

const express = require('express');
const { getDb } = require('../../config/database');
const authMiddleware = require('../../middleware/auth');
const adminAuthMiddleware = require('../../middleware/adminAuth');
const { getGpuPool } = require('../../services/vastai');

// Sub-router admin
const usersRouter   = require('./users').router;
const creditsRouter = require('./credits');
const gpuRouter     = require('./gpu');
const historyRouter = require('./history');

const router = express.Router();

// -------------------------------------------------------
// Terapkan auth middleware ke SEMUA route admin
// -------------------------------------------------------
router.use(authMiddleware);
router.use(adminAuthMiddleware);

// -------------------------------------------------------
// Mount sub-router
// -------------------------------------------------------
router.use('/users',   usersRouter);
router.use('/credits', creditsRouter);
router.use('/gpu',     gpuRouter);
router.use('/history', historyRouter);

// Endpoint ganti password admin sendiri (dipasang di root /api/admin)
// agar bisa dipanggil via POST /api/admin/change-password
const { hashPassword, comparePassword } = require('../../utils/hash');
const { v4: uuidv4 } = require('uuid');

router.post('/change-password', async (req, res) => {
  try {
    const db      = require('../../config/database').getDb();
    const adminId = req.user.id;
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({ success: false, message: 'Password saat ini dan password baru wajib diisi.' });
    }
    if (typeof new_password !== 'string' || new_password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password baru minimal 6 karakter.' });
    }
    if (current_password === new_password) {
      return res.status(400).json({ success: false, message: 'Password baru tidak boleh sama dengan password saat ini.' });
    }

    const admin = db.prepare('SELECT id, email, password_hash FROM users WHERE id = ? AND role = ?').get(adminId, 'admin');
    if (!admin) {
      return res.status(403).json({ success: false, message: 'Akun admin tidak ditemukan.' });
    }

    const isMatch = await comparePassword(current_password, admin.password_hash);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Password saat ini salah.' });
    }

    const newHash = await hashPassword(new_password);
    db.prepare('UPDATE users SET password_hash = ?, login_fail_count = 0, locked_until = NULL WHERE id = ?').run(newHash, adminId);

    // Audit log
    db.prepare('INSERT INTO audit_logs (id, admin_id, action, target_user_id, detail, ip_address, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      uuidv4(), adminId, 'CHANGE_OWN_PASSWORD', adminId, JSON.stringify({ email: admin.email }), req.ip, new Date().toISOString()
    );

    require('../../utils/logger').logger.info('Admin ' + admin.email + ' berhasil mengganti password sendiri');
    return res.json({ success: true, message: 'Password berhasil diperbarui.' });

  } catch (err) {
    require('../../utils/logger').logger.error('Change password error:', err.message);
    return res.status(500).json({ success: false, message: 'Gagal memperbarui password.' });
  }
});

// ============================================================
// GET /api/admin/dashboard — Statistik overview untuk admin
// ============================================================
router.get('/dashboard', (req, res) => {
  try {
    const db    = getDb();
    const today = new Date().toISOString().split('T')[0];

    // Statistik user
    const totalActiveUsers = db.prepare(
      "SELECT COUNT(*) as count FROM users WHERE is_active = 1 AND role = 'user'"
    ).get().count;

    // Statistik job hari ini
    const totalJobsToday = db.prepare(
      "SELECT COUNT(*) as count FROM jobs WHERE created_at LIKE ?"
    ).get(`${today}%`).count;

    // Job yang sedang pending
    const pendingJobs = db.prepare(
      "SELECT COUNT(*) as count FROM jobs WHERE status = 'pending'"
    ).get().count;

    // Job yang sedang diproses
    const processingJobs = db.prepare(
      "SELECT COUNT(*) as count FROM jobs WHERE status = 'processing'"
    ).get().count;

    // Job selesai hari ini
    const doneJobsToday = db.prepare(
      "SELECT COUNT(*) as count FROM jobs WHERE status = 'done' AND created_at LIKE ?"
    ).get(`${today}%`).count;

    // GPU pool summary
    const gpuPool   = getGpuPool();
    const gpuOnline = gpuPool.filter(g => g.status === 'online').length;

    // 10 job terbaru
    const recentJobs = db.prepare(`
      SELECT j.id, j.status, j.positive_prompt, j.created_at, j.completed_at, u.email AS user_email
      FROM jobs j JOIN users u ON j.user_id = u.id
      ORDER BY j.created_at DESC LIMIT 10
    `).all();

    return res.json({
      success: true,
      data: {
        stats: {
          totalActiveUsers,
          totalJobsToday,
          pendingJobs,
          processingJobs,
          doneJobsToday,
          gpuOnline,
        },
        gpuPool,
        recentJobs,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Gagal memuat dashboard.' });
  }
});

// ============================================================
// GET /api/admin/security/logs — Security Logs (IP, User-Agent, Events)
// ============================================================
router.get('/security/logs', (req, res) => {
  try {
    const db = getDb();
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    const logs = db.prepare(`
      SELECT *
      FROM security_logs
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);

    const total = db.prepare('SELECT COUNT(*) as count FROM security_logs').get();

    return res.json({
      success: true,
      data: {
        logs,
        pagination: { limit, offset, total: total.count },
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Gagal memuat log keamanan.' });
  }
});

module.exports = router;
