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

    const urlObj = new URL(url);
    const token = urlObj.searchParams.get('token') || req.body.token || '';
    const baseUrl = `${urlObj.protocol}//${urlObj.host}`;
    const startTime = Date.now();

    const statsUrl = token ? `${baseUrl}/system_stats?token=${token}` : `${baseUrl}/system_stats`;
    const response = await fetch(statsUrl, {
      headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      timeout: 6000,
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
    const queueUrl = token ? `${baseUrl}/queue?token=${token}` : `${baseUrl}/queue`;
    const queueRes = await fetch(queueUrl, {
      headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      timeout: 3000,
    }).catch(() => null);

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

// ============================================================
// POST /api/admin/gpu/:gpuId/mode — Ganti Mode GPU (Public / Test-Only / Disabled)
// ============================================================
router.post('/:gpuId/mode', async (req, res) => {

  try {
    const { gpuId } = req.params;
    const { isEnabled, mode, label } = req.body;

    if (!gpuId) {
      return res.status(400).json({ success: false, message: 'GPU ID wajib disertakan.' });
    }

    const { setGpuMode } = require('../../services/vastai');
    const { triggerQueueWorker } = require('../../services/jobQueue');

    const result = setGpuMode(gpuId, { isEnabled, mode, label });

    // Pemicu seketika agar antrian dialihkan ke GPU lain jika GPU ini dimatikan
    triggerQueueWorker();

    return res.json({
      success: true,
      message: `Status GPU #${gpuId} berhasil diubah menjadi: ${result.mode.toUpperCase()}`,
      data: result,
    });
  } catch (err) {
    logger.error('Error update GPU mode:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================
// POST /api/admin/gpu/:gpuId/test-benchmark — Benchmark Direct GPU Test
// ============================================================
router.post('/:gpuId/test-benchmark', async (req, res) => {
  try {
    const { gpuId } = req.params;
    const { getGpuById } = require('../../services/vastai');
    const gpu = getGpuById(gpuId);

    if (!gpu) {
      return res.status(404).json({ success: false, message: `GPU #${gpuId} tidak ditemukan dalam pool.` });
    }

    const path = require('path');
    const fs = require('fs');
    const { submitJob, getJobStatus } = require('../../services/comfyui');

    // Cari file contoh untuk benchmark
    const uploadsDir = path.join(process.cwd(), 'uploads');
    let sampleImage = null;

    if (fs.existsSync(uploadsDir)) {
      const files = fs.readdirSync(uploadsDir).filter(f => /\.(jpe?g|png)$/i.test(f));
      if (files.length > 0) sampleImage = path.join(uploadsDir, files[0]);
    }

    // Jika tidak ada gambar di uploads, buat dummy minimal 1px JPEG
    if (!sampleImage) {
      sampleImage = path.join(uploadsDir, 'benchmark_dummy.jpg');
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
      // Minimal 1x1 base64 JPEG
      const dummyJpegBase64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
      fs.writeFileSync(sampleImage, Buffer.from(dummyJpegBase64, 'base64'));
    }

    const startTime = Date.now();
    logger.info(`[Admin Benchmark] Memulai test render pada GPU #${gpuId} (${gpu.gpuName})...`);

    // Submit langsung ke GPU ini (mengabaikan mode disabled/test_only)
    const { promptId, seed } = await submitJob(gpu.url, {
      sourceImagePath: sampleImage,
      positivePrompt: 'Admin Benchmark Test photo, modern lighting, ultra sharp 8k',
      negativePrompt: 'blurry, distorted',
      seed: 123456,
      refBoost: 4.2,
      resolution: '1mp',
      token: gpu.token || '',
    });

    const submitTime = Date.now();
    let isDone = false;
    let attempts = 0;

    while (!isDone && attempts < 40) {
      attempts++;
      await new Promise(r => setTimeout(r, 2500));
      const elapsed = Date.now() - submitTime;
      const statusRes = await getJobStatus(gpu.url, promptId, gpu.token || '', elapsed);

      if (statusRes.status === 'done' && statusRes.outputFiles.length > 0) {
        isDone = true;
        const totalDurationSec = ((Date.now() - startTime) / 1000).toFixed(1);
        logger.info(`[Admin Benchmark] GPU #${gpuId} SUKSES benchmark dalam ${totalDurationSec}s!`);
        return res.json({
          success: true,
          gpuId,
          gpuName: gpu.gpuName,
          promptId,
          seed,
          durationSec: parseFloat(totalDurationSec),
          message: `Benchmark berhasil: render selesai dalam ${totalDurationSec} detik.`,
        });
      }

      if (statusRes.status === 'failed') {
        throw new Error(statusRes.error || 'ComfyUI rendering failed');
      }
    }

    throw new Error('Benchmark timed out after 100 seconds');

  } catch (err) {
    logger.warn(`[Admin Benchmark] GPU #${req.params.gpuId} gagal benchmark: ${err.message}`);
    return res.status(500).json({
      success: false,
      message: `Benchmark gagal: ${err.message}`,
    });
  }
});

module.exports = router;

