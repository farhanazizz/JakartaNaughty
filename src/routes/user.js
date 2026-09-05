/**
 * ============================================================
 * src/routes/user.js â€” Routes Dashboard User
 * ============================================================
 * Endpoints:
 *   GET /api/user/dashboard â€” Data untuk halaman dashboard
 *   GET /api/user/history   â€” History generate lengkap
 * ============================================================
 */

'use strict';

const express = require('express');
const { getDb } = require('../config/database');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// ============================================================
// GET /api/user/dashboard â€” Data ringkasan untuk dashboard
// ============================================================
router.get('/dashboard', authMiddleware, (req, res) => {
  // Anti-cache header agar saldo selalu akurat
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const db = getDb();

  // Ambil saldo kredit terbaru
  const user = db.prepare(
    'SELECT credits, email FROM users WHERE id = ? AND is_active = 1'
  ).get(req.user.id);

  if (!user) {
    return res.status(404).json({ success: false, message: 'User tidak ditemukan.' });
  }

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
  const offset = (page - 1) * limit;

  const totalRow = db.prepare(
    'SELECT COUNT(*) as count FROM jobs WHERE user_id = ?'
  ).get(req.user.id);
  const total = totalRow ? totalRow.count : 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  const recentJobs = db.prepare(`
    SELECT
      id, status, source_image_name, positive_prompt,
      credits_used, error_message, created_at, completed_at,
      output_filename, seed, job_type, output_mime
    FROM jobs
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(req.user.id, limit, offset);

  return res.json({
    success: true,
    data: {
      email: user.email,
      credits: user.credits,
      recentJobs,
      pagination: { page, limit, total, totalPages },
    },
  });
});

// ============================================================
// GET /api/user/history â€” History lengkap dengan pagination
// ============================================================
router.get('/history', authMiddleware, (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const db     = getDb();

  const limit  = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = parseInt(req.query.offset) || 0;

  const jobs = db.prepare(`
    SELECT
      id, status, source_image_name, positive_prompt, negative_prompt,
      seed, credits_used, error_message, created_at, started_at, completed_at,
      output_filename, job_type, output_mime
    FROM jobs
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(req.user.id, limit, offset);

  const total = db.prepare(
    'SELECT COUNT(*) as count FROM jobs WHERE user_id = ?'
  ).get(req.user.id);

  return res.json({
    success: true,
    data: {
      jobs,
      pagination: { limit, offset, total: total.count },
    },
  });
});

module.exports = router;
