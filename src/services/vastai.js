/**
 * ============================================================
 * src/services/vastai.js — Vast.ai API Client + Load Balancer
 * ============================================================
 * Service ini bertanggung jawab untuk:
 *  1. Mengambil daftar GPU yang sedang running dari Vast.ai API
 *  2. Cache daftar GPU (diperbarui setiap GPU_CACHE_TTL_SECONDS)
 *  3. Memilih GPU terbaik (yang antriannya paling pendek)
 *  4. Memverifikasi apakah ComfyUI di GPU tersebut accessible
 *
 * Ketika GPU diganti di Vast.ai, website otomatis detect
 * instance baru dalam waktu < GPU_CACHE_TTL_SECONDS detik.
 * ============================================================
 */

'use strict';

const fetch = require('node-fetch');
const { config } = require('../config/env');
const { logger } = require('../utils/logger');

// -------------------------------------------------------
// Cache GPU Pool
// -------------------------------------------------------

/**
 * Cache daftar GPU yang aktif.
 * Format: [{ id, url, queueLength, status }]
 */
let gpuPool = [];

/** Waktu terakhir cache diperbarui (Unix timestamp ms) */
let lastRefreshTime = 0;

/** Flag untuk mencegah multiple refresh berjalan bersamaan */
let isRefreshing = false;

// -------------------------------------------------------
// Fungsi Internal
// -------------------------------------------------------

/**
 * Membangun URL ComfyUI dari data instance Vast.ai.
 * Vast.ai menyediakan port mapping untuk setiap instance.
 *
 * @param {Object} instance - Data instance dari Vast.ai API
 * @returns {string|null} URL ComfyUI atau null jika tidak bisa dibuat
 */
function buildComfyUrl(instance) {
  const ports = instance.ports || {};
  const candidatePorts = [config.comfyui.port, 18188, 8188, 8080];

  for (const p of candidatePorts) {
    if (!p) continue;
    const portKey = `${p}/tcp`;
    const portMapping = ports[portKey];

    if (portMapping && portMapping.length > 0) {
      const externalPort = portMapping[0].HostPort;
      const host = instance.ssh_host || instance.public_ipaddr;
      if (host && externalPort) {
        return `http://${host}:${externalPort}`;
      }
    }

    if (instance.direct_port_mappings && instance.direct_port_mappings[p]) {
      return `http://${instance.ssh_host}:${instance.direct_port_mappings[p]}`;
    }
  }

  return null;
}

/**
 * Mengambil panjang antrian dari ComfyUI instance.
 * Endpoint: GET {comfyUrl}/queue
 *
 * @param {string} comfyUrl - URL base ComfyUI
 * @returns {Promise<number>} Jumlah job dalam antrian (queue_remaining + queue_running)
 */
async function getQueueLength(comfyUrl) {
  try {
    const res = await fetch(`${comfyUrl}/queue`, {
      timeout: 3000,
    });

    if (!res.ok) return Infinity;

    const data = await res.json();
    const running = (data.queue_running || []).length;
    const pending = (data.queue_pending || []).length;
    return running + pending;
  } catch {
    return Infinity;
  }
}

/**
 * Mengecek apakah ComfyUI di sebuah instance bisa diakses.
 * Coba hit endpoint /system_stats sebagai health check.
 *
 * @param {string} comfyUrl - URL base ComfyUI
 * @returns {Promise<boolean>} true jika bisa diakses
 */
async function isAccessible(comfyUrl) {
  try {
    const res = await fetch(`${comfyUrl}/system_stats`, {
      timeout: 5000,
    });
    return res.ok;
  } catch {
    return false;
  }
}

// -------------------------------------------------------
// Fungsi Publik
// -------------------------------------------------------

/**
 * Memperbarui cache daftar GPU dari Vast.ai API.
 * Fetch semua instance yang running, filter yang ada ComfyUI-nya,
 * lalu update gpuPool dengan queue length masing-masing.
 *
 * Dipanggil otomatis oleh pickBestGpu() jika cache sudah expired.
 */
async function refreshGpuPool() {
  if (isRefreshing) return;
  isRefreshing = true;

  try {
    const manualGpus = [];
    const directUrl = process.env.COMFYUI_DIRECT_URL;
    if (directUrl) {
      const accessible = await isAccessible(directUrl);
      const queueLen = accessible ? await getQueueLength(directUrl) : Infinity;
      manualGpus.push({
        id: 'manual_gpu',
        url: directUrl,
        queueLength: queueLen,
        status: accessible ? 'online' : 'offline',
        gpuName: 'Manual ComfyUI GPU',
      });
    }

    const apiKey = config.vastai.apiKey;
    let runningInstances = [];

    if (apiKey && apiKey !== 'MASUKKAN_API_KEY_VAST_AI_ANDA' && !apiKey.startsWith('mock_')) {
      const vastUrl = `https://cloud.vast.ai/api/v1/instances/?api_key=${apiKey}`;
      const res = await fetch(vastUrl, {
        headers: {
          'Accept': 'application/json',
        },
        timeout: 10000,
      });

      if (res.ok) {
        const data = await res.json();
        const instancesList = data.instances || (Array.isArray(data) ? data : []);
        runningInstances = instancesList.filter(
          (inst) => inst.actual_status === 'running' || inst.status === 'running'
        );
        logger.debug(`Vast.ai: ${instancesList.length} instance total, ${runningInstances.length} running`);
      } else {
        logger.warn(`Vast.ai API status: ${res.status}`);
      }
    }

    const poolPromises = runningInstances.map(async (instance) => {
      const url = buildComfyUrl(instance);
      if (!url) return null;

      const accessible = await isAccessible(url);
      if (!accessible) {
        logger.debug(`GPU ${instance.id} tidak accessible: ${url}`);
        return null;
      }

      const queueLength = await getQueueLength(url);

      return {
        id: instance.id.toString(),
        url,
        queueLength,
        status: 'online',
        gpuName: instance.gpu_name || 'Unknown GPU',
        machineId: instance.machine_id,
      };
    });

    const results = await Promise.all(poolPromises);
    gpuPool = [...manualGpus, ...results.filter(Boolean)];
    lastRefreshTime = Date.now();

    logger.info(`GPU pool diperbarui: ${gpuPool.length} GPU online`);
    gpuPool.forEach((gpu) => {
      logger.debug(`  GPU ${gpu.id}: ${gpu.url} | queue=${gpu.queueLength}`);
    });

  } catch (err) {
    logger.error('Gagal memperbarui GPU pool:', err.message);
  } finally {
    isRefreshing = false;
  }
}

/**
 * Memilih GPU terbaik untuk menjalankan job berikutnya.
 * Strategi: pilih GPU dengan antrian terpendek (Least Queue).
 *
 * @returns {Promise<{id, url, queueLength}|null>} GPU terpilih atau null jika tidak ada
 */
async function pickBestGpu() {
  const now = Date.now();
  const cacheAge = (now - lastRefreshTime) / 1000; // Usia cache dalam detik

  // Refresh cache jika sudah expired atau pool kosong
  if (cacheAge > config.vastai.cacheTtlSeconds || gpuPool.length === 0) {
    await refreshGpuPool();
  }

  // Jika tidak ada GPU yang online
  if (gpuPool.length === 0) {
    logger.warn('Tidak ada GPU yang online saat ini');
    return null;
  }

  // Pilih GPU dengan antrian terpendek
  const best = gpuPool.reduce((prev, curr) =>
    curr.queueLength < prev.queueLength ? curr : prev
  );

  logger.debug(`GPU terpilih: ${best.id} | queue=${best.queueLength}`);
  return best;
}

/**
 * Mendapatkan daftar semua GPU yang ada di cache.
 * Dipakai oleh admin panel untuk monitoring.
 *
 * @returns {Array} Daftar GPU dengan info lengkap
 */
function getGpuPool() {
  return gpuPool;
}

module.exports = { pickBestGpu, refreshGpuPool, getGpuPool };
