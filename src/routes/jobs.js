/**
 * ============================================================
 * src/routes/jobs.js — Route Status dan Download Job
 * ============================================================
 * Endpoints:
 *   GET /api/jobs           — List semua job milik user
 *   GET /api/jobs/:jobId    — Status satu job
 *   GET /api/jobs/:jobId/image — Download/view gambar hasil
 * ============================================================
 */

'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { getDb } = require('../config/database');
const { getQueuePosition } = require('../services/jobQueue');
const authMiddleware = require('../middleware/auth');
const { config } = require('../config/env');

const router = express.Router();

// ============================================================
// GET /api/jobs — List semua job milik user yang login
// ============================================================
router.get('/', authMiddleware, (req, res) => {
  const db     = getDb();
  const limit  = Math.min(parseInt(req.query.limit) || 10, 50); // Maks 50
  const offset = parseInt(req.query.offset) || 0;

  const jobs = db.prepare(`
    SELECT
      id, status, source_image_name, positive_prompt, negative_prompt,
      seed, credits_used, error_message, created_at, started_at, completed_at,
      output_filename
    FROM jobs
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(req.user.id, limit, offset);

  // Total count untuk pagination
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

// ============================================================
// GET /api/jobs/:jobId — Status detail satu job
// ============================================================
router.get('/:jobId', authMiddleware, (req, res) => {
  const db  = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.jobId);

  // Job tidak ditemukan
  if (!job) {
    return res.status(404).json({ success: false, message: 'Job tidak ditemukan.' });
  }

  // Pastikan job ini milik user yang request atau user adalah admin
  if (job.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Akses ditolak.' });
  }

  // Bangun response sesuai status job
  const responseData = {
    id:           job.id,
    status:       job.status,
    createdAt:    job.created_at,
    positivePrompt: job.positive_prompt,
    sourceImageName: job.source_image_name,
  };

  if (job.status === 'pending') {
    // Hitung posisi dalam antrian
    responseData.queuePosition = getQueuePosition(job.id);
  }

  if (job.status === 'processing') {
    responseData.startedAt = job.started_at;
  }

  if (job.status === 'done') {
    responseData.completedAt = job.completed_at;
    responseData.seed        = job.seed;
    // URL untuk download/view gambar (Cloudflare R2 CDN atau proxy lokal)
    responseData.outputUrl   = job.output_filename?.startsWith('http')
      ? job.output_filename
      : `/api/jobs/${job.id}/image`;
  }

  if (job.status === 'expired') {
    responseData.errorMessage = 'This image has expired and was automatically cleaned up after 3 days.';
  }

  if (job.status === 'failed') {
    responseData.errorMessage = job.error_message || 'An error occurred during image generation.';
  }

  return res.json({ success: true, data: responseData });
});

// ============================================================
// GET /api/jobs/:jobId/image — Stream gambar hasil atau redirect ke R2 CDN
// ============================================================
router.get('/:jobId/image', authMiddleware, (req, res) => {
  const db  = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.jobId);

  // Validasi job ada dan milik user ini (atau admin)
  if (!job) {
    return res.status(404).json({ success: false, message: 'Job not found.' });
  }
  if (job.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Access denied.' });
  }

  if (job.status === 'expired') {
    return res.status(410).json({ success: false, message: 'Image expired and cleaned up after 3 days.' });
  }

  if (job.status !== 'done') {
    return res.status(404).json({ success: false, message: 'Image is not ready yet.' });
  }
  if (!job.output_filename) {
    return res.status(404).json({ success: false, message: 'Output file not found.' });
  }

  // Jika tersimpan di Cloudflare R2, redirect ke CDN publik R2
  if (job.output_filename.startsWith('http://') || job.output_filename.startsWith('https://')) {
    return res.redirect(job.output_filename);
  }

  // Resolve path file output lokal — pastikan ada di dalam folder outputs/ (anti path traversal)
  const outputDir  = path.resolve(config.upload.outputDir);
  const filePath   = path.resolve(outputDir, job.output_filename);

  // Security: pastikan path tidak keluar dari folder outputs/
  if (!filePath.startsWith(outputDir)) {
    return res.status(403).json({ success: false, message: 'Unauthorized file access.' });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, message: 'Output file not found on server.' });
  }

  // Stream file ke client
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'private, max-age=86400'); // Cache 1 hari di browser
  fs.createReadStream(filePath).pipe(res);
});


module.exports = router;
