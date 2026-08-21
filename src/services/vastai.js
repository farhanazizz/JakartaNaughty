/**
 * ============================================================
 * src/services/vastai.js — Vast.ai API Client + Load Balancer
 * ============================================================
 * Service ini bertanggung jawab untuk:
 *  1. Mengambil daftar GPU yang sedang running dari Vast.ai API v1
 *  2. Cache daftar GPU (diperbarui setiap GPU_CACHE_TTL_SECONDS)
 *  3. Memilih GPU terbaik (antrian paling pendek)
 *  4. Mendeteksi token autentikasi ComfyUI (jupyter_token) otomatis
 * ============================================================
 */

'use strict';

const fetch = require('node-fetch');
const { config } = require('../config/env');
const { logger } = require('../utils/logger');

// -------------------------------------------------------
// Cache GPU Pool
// -------------------------------------------------------
let gpuPool = [];
let lastRefreshTime = 0;
let isRefreshing = false;

// -------------------------------------------------------
// Fungsi Internal
// -------------------------------------------------------

/**
 * Membangun URL ComfyUI dari data instance Vast.ai.
 * Prioritas host: public_ipaddr (IP langsung) -> ssh_host.
 * Prioritas port internal ComfyUI: 18188, 8188, 8288, 8080.
 */
function buildComfyUrl(instance) {
  const ports = instance.ports || {};
  const candidatePorts = [config.comfyui.port, 18188, 8188, 8288, 8080, 10100];
  const host = instance.public_ipaddr || instance.ssh_host;

  for (const p of candidatePorts) {
    if (!p) continue;
    const portKey = `${p}/tcp`;
    const portMapping = ports[portKey];

    if (portMapping && portMapping.length > 0) {
      const externalPort = portMapping[0].HostPort;
      if (host && externalPort) {
        return `http://${host}:${externalPort}`;
      }
    }

    if (instance.direct_port_mappings && instance.direct_port_mappings[p]) {
      return `http://${host}:${instance.direct_port_mappings[p]}`;
    }
  }

  return null;
}

/**
 * Mengambil panjang antrian dari ComfyUI instance.
 */
async function getQueueLength(comfyUrl, token = '') {
  try {
    const url = token ? `${comfyUrl}/queue?token=${token}` : `${comfyUrl}/queue`;
    const res = await fetch(url, {
      headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      timeout: 4000,
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
 */
async function isAccessible(comfyUrl, token = '') {
  try {
    const url = token ? `${comfyUrl}/system_stats?token=${token}` : `${comfyUrl}/system_stats`;
    const res = await fetch(url, {
      headers: token ? { 'Authorization': `Bearer ${token}` } : {},
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
 * Memperbarui cache daftar GPU dari Vast.ai API v1.
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
        token: '',
        queueLength: queueLen,
        status: accessible ? 'online' : 'offline',
        gpuName: 'Manual ComfyUI Cluster',
      });
    }

    const apiKey = config.vastai.apiKey;
    let runningInstances = [];

    if (apiKey && apiKey !== 'MASUKKAN_API_KEY_VAST_AI_ANDA' && !apiKey.startsWith('mock_')) {
      const vastUrl = `https://cloud.vast.ai/api/v1/instances/?api_key=${apiKey}`;
      const res = await fetch(vastUrl, {
        headers: { 'Accept': 'application/json' },
        timeout: 10000,
      });

      if (res.ok) {
        const data = await res.json();
        const instancesList = data.instances || (Array.isArray(data) ? data : []);
        runningInstances = instancesList.filter(
          (inst) => inst.actual_status === 'running' || inst.status === 'running' || inst.cur_state === 'running'
        );
        logger.debug(`Vast.ai: ${instancesList.length} total instance, ${runningInstances.length} running`);
      } else {
        logger.warn(`Vast.ai API status: ${res.status}`);
      }
    }

    const poolPromises = runningInstances.map(async (instance) => {
      const url = buildComfyUrl(instance);
      if (!url) return null;

      const token = instance.jupyter_token || '';
      const accessible = await isAccessible(url, token);
      if (!accessible) {
        logger.debug(`GPU ${instance.id} tidak accessible: ${url}`);
        return null;
      }

      const queueLength = await getQueueLength(url, token);

      return {
        id: instance.id.toString(),
        url,
        token,
        queueLength,
        status: 'online',
        gpuName: instance.gpu_name ? `${instance.gpu_name} (${instance.num_gpus || 1}x)` : 'RTX GPU',
        machineId: instance.machine_id,
      };
    });

    const results = await Promise.all(poolPromises);
    gpuPool = [...manualGpus, ...results.filter(Boolean)];
    lastRefreshTime = Date.now();

    logger.info(`GPU pool diperbarui: ${gpuPool.length} GPU online`);
    gpuPool.forEach((gpu) => {
      logger.info(`  ⚡ GPU ${gpu.id}: ${gpu.gpuName} @ ${gpu.url} | antrian=${gpu.queueLength}`);
    });

  } catch (err) {
    logger.error('Gagal memperbarui GPU pool:', err.message);
  } finally {
    isRefreshing = false;
  }
}

/**
 * Memilih GPU terbaik dengan antrian terpendek.
 */
async function pickBestGpu() {
  const now = Date.now();
  const cacheAge = (now - lastRefreshTime) / 1000;

  if (cacheAge > config.vastai.cacheTtlSeconds || gpuPool.length === 0) {
    await refreshGpuPool();
  }

  if (gpuPool.length === 0) {
    logger.warn('Tidak ada GPU yang online saat ini');
    return null;
  }

  const best = gpuPool.reduce((prev, curr) =>
    curr.queueLength < prev.queueLength ? curr : prev
  );

  return best;
}

/**
 * Mendapatkan daftar GPU pool yang sedang aktif.
 */
function getGpuPool() {
  return gpuPool;
}

module.exports = { pickBestGpu, refreshGpuPool, getGpuPool, isAccessible, getQueueLength };
