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
