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
// Cache GPU Pool & In-Flight Tracker
// -------------------------------------------------------
let gpuPool = [];
let lastRefreshTime = 0;
let isRefreshing = false;
let roundRobinIndex = 0;

// Melacak jumlah job aktif yang sedang berjalan di tiap GPU secara realtime
const inFlightByGpu = new Map();

/**
 * Mendapatkan jumlah job aktif (in-flight) di suatu GPU.
 * @param {string} gpuId
 * @returns {number}
 */
function getInFlight(gpuId) {
  return inFlightByGpu.get(String(gpuId)) || 0;
}

/**
 * Menambah counter job aktif (in-flight) untuk suatu GPU.
 * @param {string} gpuId
 */
function incrementInFlight(gpuId) {
  const current = getInFlight(gpuId);
  inFlightByGpu.set(String(gpuId), current + 1);
  logger.debug(`GPU ${gpuId} in-flight bertambah -> ${current + 1}`);
}

/**
 * Mengurangi counter job aktif (in-flight) untuk suatu GPU.
 * @param {string} gpuId
 */
function decrementInFlight(gpuId) {
  const current = getInFlight(gpuId);
  const next = Math.max(0, current - 1);
  inFlightByGpu.set(String(gpuId), next);
  logger.debug(`GPU ${gpuId} in-flight berkurang -> ${next}`);
}

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
        inFlight: getInFlight('manual_gpu'),
        status: accessible ? 'online' : 'offline',
        gpuName: 'Manual ComfyUI Cluster',
      });
    }

    const apiKey = config.vastai.apiKey;
    let runningInstances = [];

    if (apiKey && apiKey !== 'MASUKKAN_API_KEY_VAST_AI_ANDA' && !apiKey.startsWith('mock_')) {
      const vastUrl = `https://console.vast.ai/api/v1/instances/`;
      const res = await fetch(vastUrl, {
        headers: {
          'Accept': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
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
      const instIdStr = instance.id.toString();

      return {
        id: instIdStr,
        url,
        token,
        queueLength,
        inFlight: getInFlight(instIdStr),
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
      logger.info(`  ⚡ GPU ${gpu.id}: ${gpu.gpuName} @ ${gpu.url} | queue=${gpu.queueLength} | inFlight=${getInFlight(gpu.id)}`);
    });

  } catch (err) {
    logger.error('Gagal memperbarui GPU pool:', err.message);
  } finally {
    isRefreshing = false;
  }
}

/**
 * Memilih GPU terbaik secara dinamis menggunakan Least-Connection + Round-Robin.
 * Mendukung daftar eksklusi GPU jika terjadi failover.
 *
 * @param {Array<string>} [excludeGpuIds=[]] - ID GPU yang dilewati (misal yang baru saja gagal)
 * @returns {Promise<Object|null>} GPU terpilih
 */
async function pickBestGpu(excludeGpuIds = []) {
  const now = Date.now();
  const cacheAge = (now - lastRefreshTime) / 1000;

  // Refresh pool jika cache sudah lebih dari 15 detik atau pool kosong
  if (cacheAge > 15 || gpuPool.length === 0) {
    await refreshGpuPool();
  }

  if (gpuPool.length === 0) {
    logger.warn('Tidak ada GPU yang online saat ini');
    return null;
  }

  // Filter GPU yang online dan bukan GPU yang dikecualikan
  const excludeSet = new Set((excludeGpuIds || []).map(String));
  const availableGpus = gpuPool.filter(g => g.status === 'online' && !excludeSet.has(String(g.id)));

  if (availableGpus.length === 0) {
    // Jika semua GPU masuk daftar exclude, fallback ke GPU online mana saja yang ada
    logger.warn('Semua GPU dalam exclude list, mencoba fallback ke GPU online mana saja...');
    const anyOnline = gpuPool.filter(g => g.status === 'online');
    if (anyOnline.length === 0) return null;
    return pickFromCandidates(anyOnline);
  }

  return pickFromCandidates(availableGpus);
}

/**
 * Memilih kandidat GPU terbaik berdasarkan total beban efektif & Round-Robin.
 * @private
 */
function pickFromCandidates(candidates) {
  // Hitung total beban efektif (antrian server + tugas lokal in-flight)
  const scored = candidates.map(gpu => {
    const inFlight = getInFlight(gpu.id);
    const effectiveLoad = (gpu.queueLength === Infinity ? 999 : (gpu.queueLength || 0)) + inFlight;
    return { gpu, effectiveLoad };
  });

  // Cari beban terkecil
  let minLoad = Infinity;
  for (const item of scored) {
    if (item.effectiveLoad < minLoad) minLoad = item.effectiveLoad;
  }

  // Ambil semua GPU yang memiliki beban terkecil (tie)
  const bestCandidates = scored.filter(item => item.effectiveLoad === minLoad).map(item => item.gpu);

  // Jika ada lebih dari 1 GPU dengan beban sama, gunakan Round-Robin bergantian
  const chosenIndex = roundRobinIndex % bestCandidates.length;
  roundRobinIndex++;
  const chosenGpu = bestCandidates[chosenIndex];

  // Naikkan counter in-flight secara realtime seketika itu juga
  incrementInFlight(chosenGpu.id);

  logger.info(
    `[Load Balancer] Dipilih GPU ${chosenGpu.id} (${chosenGpu.gpuName}) | ` +
    `Queue=${chosenGpu.queueLength}, InFlight=${getInFlight(chosenGpu.id)} | Total Kandidat Online=${candidates.length}`
  );

  return chosenGpu;
}

/**
 * Mendapatkan daftar GPU pool yang sedang aktif beserta in-flight count.
 */
function getGpuPool() {
  return gpuPool.map(g => ({
    ...g,
    inFlight: getInFlight(g.id),
  }));
}

module.exports = {
  pickBestGpu,
  refreshGpuPool,
  getGpuPool,
  isAccessible,
  getQueueLength,
  incrementInFlight,
  decrementInFlight,
  getInFlight,
};

