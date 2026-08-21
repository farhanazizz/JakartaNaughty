/**
 * ============================================================
 * src/routes/admin/history.js — Admin: History Generate Semua User
 * ============================================================
 * Endpoints:
 *   GET /api/admin/history — Semua job dari semua user dengan filter
 * ============================================================
 */

'use strict';

const express = require('express');
const { getDb } = require('../../config/database');

const router = express.Router();

// ============================================================
// GET /api/admin/history — Semua history generate
// ============================================================
router.get('/', (req, res) => {
  const db     = getDb();
  const limit  = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = parseInt(req.query.offset) || 0;

  // Bangun query dengan filter yang dinamis
  let query  = `
    SELECT
      j.*,
      u.email AS user_email
    FROM jobs j
    JOIN users u ON j.user_id = u.id
    WHERE 1=1
  `;
  const params = [];

  // Filter by status
  if (req.query.status) {
    query += ' AND j.status = ?';
    params.push(req.query.status);
  }

  // Filter by user_id
  if (req.query.user_id) {
    query += ' AND j.user_id = ?';
    params.push(req.query.user_id);
  }

  // Filter by date range
  if (req.query.date_from) {
    query += ' AND j.created_at >= ?';
    params.push(req.query.date_from);
  }
  if (req.query.date_to) {
    query += ' AND j.created_at <= ?';
    params.push(req.query.date_to);
  }

  // Urut dan batasi
  query += ' ORDER BY j.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const jobs = db.prepare(query).all(...params);

  return res.json({ success: true, data: jobs });
});

module.exports = router;
