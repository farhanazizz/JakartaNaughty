/**
 * ============================================================
 * src/routes/admin/system.js — Admin: System Health, R2 Storage & Error Diagnostics
 * ============================================================
 * Endpoints:
 *   GET  /api/admin/system/health     — Live System & Infrastructure Matrix
 *   GET  /api/admin/system/errors     — Failure Diagnostic Center & Error Codes
 *   POST /api/admin/system/cleanup-r2 — Trigger 3-day retention cleaner manually
 * ============================================================
 */

'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { getDb } = require('../../config/database');
const { config } = require('../../config/env');
const { getEndpointHealth } = require('../../services/runpod');
const { isR2Active } = require('../../services/r2Storage');
const { cleanExpiredJobs } = require('../../services/jobQueue');
const { logger } = require('../../utils/logger');

const router = express.Router();

/**
 * Helper untuk mengelompokkan pesan error ke dalam kode error terstandarisasi.
 */
function classifyErrorCode(errMsg) {
  if (!errMsg) return 'ERR_UNKNOWN';
  const lower = errMsg.toLowerCase();
  if (lower.includes('timeout') || lower.includes('melebihi batas waktu')) return 'ERR_TIMEOUT';
  if (lower.includes('not reachable') || lower.includes('koneksi terputus') || lower.includes('refused')) return 'ERR_WORKER_UNREACHABLE';
  if (lower.includes('clip') || lower.includes('unet') || lower.includes('node') || lower.includes('comfyui')) return 'ERR_COMFY_NODE';
  if (lower.includes('format') || lower.includes('image') || lower.includes('jpeg') || lower.includes('png')) return 'ERR_IMAGE_INPUT';
  if (lower.includes('credit') || lower.includes('saldo')) return 'ERR_CREDIT_INSUFFICIENT';
  return 'ERR_GENERAL_FAILURE';
}

// ============================================================
// GET /api/admin/system/health — Matriks Kesehatan Sistem & R2
// ============================================================
router.get('/health', async (req, res) => {
  try {
    const db = getDb();

    // 1. RunPod Serverless Health
    const serverless = await getEndpointHealth();

    // 2. Cloudflare R2 Storage Status
    const r2Active = isR2Active();
    const totalActiveR2Files = db.prepare(
      "SELECT COUNT(*) as count FROM jobs WHERE status = 'done' AND output_filename LIKE 'http%'"
    ).get().count;

    const totalExpiredFiles = db.prepare(
      "SELECT COUNT(*) as count FROM jobs WHERE status = 'expired'"
    ).get().count;

    // Estimasi ukuran storage R2 (rata-rata 1.25 MB per foto HD)
    const estimatedR2SizeMb = (totalActiveR2Files * 1.25).toFixed(1);

    // 3. Database SQLite Info
    const dbFilePath = process.env.DB_PATH || path.join(process.cwd(), 'krea2.db');
    let dbFileSizeBytes = 0;
    try {
      if (fs.existsSync(dbFilePath)) {
        dbFileSizeBytes = fs.statSync(dbFilePath).size;
      }
    } catch (_) {}

    const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    const totalJobs = db.prepare('SELECT COUNT(*) as count FROM jobs').get().count;
    const totalLedger = db.prepare("SELECT COUNT(*) as count FROM audit_logs WHERE action LIKE '%CREDIT%'").get().count;

    // 4. Server Process & RAM
    const mem = process.memoryUsage();
    const uptimeSec = process.uptime();

    // 5. Total Kredit Beredar
    const creditPool = db.prepare("SELECT SUM(credits) as total FROM users WHERE role = 'user'").get().total || 0;
    const totalCreditsSpent = db.prepare("SELECT SUM(credits_used) as total FROM jobs WHERE status = 'done'").get().total || 0;

    return res.json({
      success: true,
      data: {
        serverless: {
          online: serverless.online,
          endpointId: serverless.endpointId,
          message: serverless.message,
          workers: serverless.workers,
          jobs: serverless.jobs,
          gpuModel: 'NVIDIA GeForce RTX 4090 (ADA_24)',
          datacenter: 'EU-RO-1',
          networkVolumeId: 'xzwtxegfxu',
          storageSizeGb: 50,
        },
        storage: {
          r2Active,
          bucketName: config.r2.bucketName || 'jakartanaughty',
          publicDomain: config.r2.publicDomain || 'https://pub-d347c89dddda4d359aaf6b53808fc497.r2.dev',
          totalActiveFiles: totalActiveR2Files,
          totalExpiredCleaned: totalExpiredFiles,
          estimatedSizeMb: parseFloat(estimatedR2SizeMb),
          retentionPolicyDays: 3,
        },
        database: {
          type: 'SQLite WASM (Pure JS/Memory-Mapped)',
          fileSizeBytes: dbFileSizeBytes,
          fileSizeKb: (dbFileSizeBytes / 1024).toFixed(1),
          totalUsers,
          totalJobs,
          totalLedgerTransactions: totalLedger,
        },
        system: {
          nodeVersion: process.version,
          platform: process.platform,
          uptimeSeconds: Math.floor(uptimeSec),
          uptimeFormatted: `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m ${Math.floor(uptimeSec % 60)}s`,
          memory: {
            heapUsedMb: (mem.heapUsed / 1024 / 1024).toFixed(1),
            heapTotalMb: (mem.heapTotal / 1024 / 1024).toFixed(1),
            rssMb: (mem.rss / 1024 / 1024).toFixed(1),
          },
        },
        financial: {
          circulatingCredits: creditPool,
          totalCreditsUsed: totalCreditsSpent,
          estimatedRunPodCostIdr: Math.round(totalCreditsSpent * 105),
        },
      },
    });
  } catch (err) {
    logger.error('Error di /api/admin/system/health:', err.message);
    return res.status(500).json({ success: false, message: 'Gagal mengambil data kesehatan sistem.' });
  }
});

// ============================================================
// GET /api/admin/system/errors — Failure Diagnostic & Error Log
// ============================================================
router.get('/errors', (req, res) => {
  try {
    const db = getDb();
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);

    const failedJobs = db.prepare(`
      SELECT j.id, j.user_id, u.email as user_email, j.status, j.positive_prompt,
             j.error_message, j.credits_used, j.created_at, j.completed_at
      FROM jobs j
      LEFT JOIN users u ON j.user_id = u.id
      WHERE j.status = 'failed'
      ORDER BY j.created_at DESC
      LIMIT ?
    `).all(limit);

    // Hitung Rasio Sukses vs Gagal
    const totalDone = db.prepare("SELECT COUNT(*) as count FROM jobs WHERE status = 'done'").get().count;
    const totalFailed = db.prepare("SELECT COUNT(*) as count FROM jobs WHERE status = 'failed'").get().count;
    const totalAll = totalDone + totalFailed;
    const successRate = totalAll > 0 ? ((totalDone / totalAll) * 100).toFixed(1) : '100.0';

    // Kelompokkan failed jobs dengan error code
    const formattedErrors = failedJobs.map((j) => ({
      ...j,
      errorCode: classifyErrorCode(j.error_message),
      isRefunded: true,
    }));

    return res.json({
      success: true,
      data: {
        summary: {
          totalCompleted: totalDone,
          totalFailed: totalFailed,
          successRatePercent: parseFloat(successRate),
        },
        errors: formattedErrors,
      },
    });
  } catch (err) {
    logger.error('Error di /api/admin/system/errors:', err.message);
    return res.status(500).json({ success: false, message: 'Gagal mengambil data log error.' });
  }
});

// ============================================================
// POST /api/admin/system/cleanup-r2 — Manual Trigger 3-Day Cleanup
// ============================================================
router.post('/cleanup-r2', async (req, res) => {
  try {
    logger.info(`[Admin Action] Manual 3-Day R2 Retention Cleanup dipicu oleh admin ${req.user.email}`);
    await cleanExpiredJobs();

    const db = getDb();
    const expiredCount = db.prepare("SELECT COUNT(*) as count FROM jobs WHERE status = 'expired'").get().count;

    return res.json({
      success: true,
      message: 'Pembersihan file kadaluarsa (>3 hari) berhasil dijalankan.',
      totalCleaned: expiredCount,
    });
  } catch (err) {
    logger.error('Error manual cleanup R2:', err.message);
    return res.status(500).json({ success: false, message: 'Gagal menjalankan pembersihan storage.' });
  }
});

module.exports = router;
