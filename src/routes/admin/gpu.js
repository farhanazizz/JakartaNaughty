/**
 * ============================================================
 * src/routes/admin/gpu.js — Admin: Monitor GPU
 * ============================================================
 * Endpoints:
 *   GET /api/admin/gpu/status — Status semua GPU yang aktif
 * ============================================================
 */

'use strict';

const express = require('express');
const { refreshGpuPool, getGpuPool } = require('../../services/vastai');
const { logger } = require('../../utils/logger');

const router = express.Router();

// ============================================================
// GET /api/admin/gpu/status — Status GPU pool
// ============================================================
router.get('/status', async (req, res) => {
  try {
    // Refresh pool dari Vast.ai API (bisa ambil data terbaru)
    await refreshGpuPool();

    // Ambil data GPU yang sudah di-cache
    const gpus = getGpuPool();

    return res.json({
      success: true,
      data: {
        gpus,
        totalOnline:   gpus.length,
        lastRefreshed: new Date().toISOString(),
      },
    });

  } catch (err) {
    logger.error('GPU status error:', err.message);
    return res.status(500).json({ success: false, message: 'Gagal mengambil status GPU.' });
  }
});

module.exports = router;
