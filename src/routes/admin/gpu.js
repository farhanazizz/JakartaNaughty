/**
 * ============================================================
 * src/routes/admin/gpu.js — Admin: Monitor & Diagnostik GPU Fleet
 * ============================================================
 * Endpoints:
 *   GET  /api/admin/gpu/status — Status semua GPU aktif (Vast.ai + Manual)
 *   POST /api/admin/gpu/ping   — Live ping test ke URL ComfyUI dengan latensi (ms)
 * ============================================================
 */

'use strict';

const express = require('express');
const fetch = require('node-fetch');
const { refreshGpuPool, getGpuPool } = require('../../services/vastai');
const { logger } = require('../../utils/logger');

const router = express.Router();

// ============================================================
// GET /api/admin/gpu/status — Status GPU pool
// ============================================================
router.get('/status', async (req, res) => {
  try {
    await refreshGpuPool();
    const gpus = getGpuPool();

    return res.json({
      success: true,
      data: {
        gpus,
        totalOnline: gpus.filter(g => g.status === 'online').length,
        totalConfigured: gpus.length,
        lastRefreshed: new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.error('GPU status error:', err.message);
    return res.status(500).json({ success: false, message: 'Gagal mengambil status GPU.' });
  }
});

// ============================================================
// POST /api/admin/gpu/ping — Live Ping & Health Check ComfyUI
// ============================================================
router.post('/ping', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || typeof url !== 'string' || !url.startsWith('http')) {
      return res.status(400).json({ success: false, message: 'URL ComfyUI tidak valid.' });
    }

    const cleanUrl = url.replace(/\/+$/, '');
    const startTime = Date.now();

    const response = await fetch(`${cleanUrl}/system_stats`, {
      timeout: 5000,
    });

    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      return res.json({
        success: false,
        online: false,
        latencyMs,
        message: `HTTP ${response.status} dari server GPU`,
      });
    }

    const data = await response.json();
    const queueRes = await fetch(`${cleanUrl}/queue`, { timeout: 3000 }).catch(() => null);
    let queueCount = 0;
    if (queueRes && queueRes.ok) {
      const qData = await queueRes.json();
      queueCount = (qData.queue_running || []).length + (qData.queue_pending || []).length;
    }

    return res.json({
      success: true,
      online: true,
      latencyMs,
      systemStats: {
        comfyui_version: data?.system?.comfyui_version || 'Active',
        os: data?.system?.os || 'Linux',
        devices: data?.devices || [],
      },
      queueCount,
      message: `Terkoneksi normal (${latencyMs}ms)`,
    });
  } catch (err) {
    return res.json({
      success: false,
      online: false,
      message: `Koneksi gagal: ${err.message}`,
    });
  }
});

module.exports = router;
