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
 * Mengecek apakah ComfyUI di sebuah instance bisa diakses dan
 * sudah siap dengan seluruh custom node yang dibutuhkan oleh pipeline kita.
 *
 * @param {string} comfyUrl
 * @param {string} [token='']
 * @returns {Promise<boolean>}
 */
async function isAccessible(comfyUrl, token = '') {
  try {
    const statsUrl = token ? `${comfyUrl}/system_stats?token=${token}` : `${comfyUrl}/system_stats`;
    const res = await fetch(statsUrl, {
      headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      timeout: 5000,
    });
    if (!res.ok) return false;

    // Deep Health Check: Verifikasi apakah custom nodes inti sudah terload di ComfyUI
    const objUrl = token ? `${comfyUrl}/object_info?token=${token}` : `${comfyUrl}/object_info`;
    const objRes = await fetch(objUrl, {
      headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      timeout: 7000,
    });

    if (!objRes.ok) return false;

    const objInfo = await objRes.json();
    const hasKreaPatch = Boolean(objInfo['Krea2EditModelPatch']);
    const hasGrounded  = Boolean(objInfo['Krea2EditGroundedEncode']);

    if (!hasKreaPatch || !hasGrounded) {
      logger.warn(`GPU @ ${comfyUrl} belum siap (Custom Nodes Krea2Edit belum terpasang: KreaPatch=${hasKreaPatch}, Grounded=${hasGrounded})`);
      return false;
    }

    return true;

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
    const discovered = [...manualGpus, ...results.filter(Boolean)];

    // Sinkronkan status ON / OFF / Mode dari database
    let settingsMap = new Map();
    try {
      const { getDb } = require('../config/database');
      const db = getDb();
      const rows = db.prepare('SELECT * FROM gpu_settings').all();
      rows.forEach((r) => settingsMap.set(String(r.gpu_id), r));
    } catch (_) {}

    gpuPool = discovered.map((gpu) => {
      const setting = settingsMap.get(String(gpu.id));
      let isEnabled = true;
      let mode = 'public';
      let label = '';

      if (setting) {
        isEnabled = setting.is_enabled === 1;
        mode = setting.mode || (isEnabled ? 'public' : 'disabled');
        label = setting.label || '';
      } else {
        // Daftarkan GPU baru ke database dengan mode default 'public'
        try {
          const { getDb } = require('../config/database');
          const db = getDb();
          db.prepare(`
            INSERT OR IGNORE INTO gpu_settings (gpu_id, is_enabled, mode, label, updated_at)
            VALUES (?, 1, 'public', '', ?)
          `).run(String(gpu.id), new Date().toISOString());
        } catch (_) {}
      }

      return {
        ...gpu,
        isEnabled,
        mode,
        label,
      };
    });

    lastRefreshTime = Date.now();

    logger.info(`GPU pool diperbarui: ${gpuPool.length} GPU terdeteksi`);
    gpuPool.forEach((gpu) => {
      const modeEmoji = gpu.mode === 'public' ? '🟢 Public' : gpu.mode === 'test_only' ? '🟡 Test-Only' : '🔴 Disabled';
      logger.info(`  ⚡ GPU ${gpu.id}: ${gpu.gpuName} [${modeEmoji}] @ ${gpu.url} | queue=${gpu.queueLength} | inFlight=${getInFlight(gpu.id)}`);
    });

  } catch (err) {
    logger.error('Gagal memperbarui GPU pool:', err.message);
  } finally {
    isRefreshing = false;
  }
}

/**
 * Mengubah mode operasional GPU (Public, Test-Only, Disabled).
 *
 * @param {string} gpuId
 * @param {Object} options
 * @param {boolean} [options.isEnabled]
 * @param {string} [options.mode] - 'public' | 'test_only' | 'disabled'
 * @param {string} [options.label]
 */
function setGpuMode(gpuId, { isEnabled, mode, label }) {
  const idStr = String(gpuId);
  const targetMode = mode || (isEnabled === false ? 'disabled' : 'public');
  const isEn = targetMode === 'disabled' ? 0 : 1;
  const now = new Date().toISOString();


  try {
    const { getDb } = require('../config/database');
    const db = getDb();

    db.prepare(`
      INSERT INTO gpu_settings (gpu_id, is_enabled, mode, label, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(gpu_id) DO UPDATE SET
        is_enabled = excluded.is_enabled,
        mode = excluded.mode,
        label = COALESCE(excluded.label, gpu_settings.label),
        updated_at = excluded.updated_at
    `).run(idStr, isEn, targetMode, label || '', now);
  } catch (dbErr) {
    logger.warn('Gagal simpan setGpuMode ke DB:', dbErr.message);
  }

  // Update memori pool
  const gpu = gpuPool.find((g) => String(g.id) === idStr);
  if (gpu) {
    gpu.isEnabled = isEn === 1;
    gpu.mode = targetMode;
    if (label !== undefined) gpu.label = label;
  }

  logger.info(`[GPU Orchestrator] Status GPU #${idStr} diperbarui -> isEnabled=${isEn === 1}, mode=${targetMode}`);
  return { success: true, gpuId: idStr, isEnabled: isEn === 1, mode: targetMode };
}

/**
 * Mendapatkan satu GPU spesifik berdasarkan ID.
 * @param {string} gpuId
 * @returns {Object|null}
 */
function getGpuById(gpuId) {
  return gpuPool.find((g) => String(g.id) === String(gpuId)) || null;
}

/**
 * Memilih GPU terbaik secara dinamis menggunakan Least-Connection + Round-Robin.
 * Hanya memilih GPU yang berstatus ONLINE, ENABLED (ON), dan MODE PUBLIC.
 *
 * @param {Array<string>} [excludeGpuIds=[]] - ID GPU yang dilewati (misal yang baru saja gagal)
 * @returns {Promise<Object|null>} GPU terpilih
 */
async function pickBestGpu(excludeGpuIds = []) {
  // Jika pool kosong, lakukan refresh darurat
  if (gpuPool.length === 0) {
    await refreshGpuPool();
  }

  if (gpuPool.length === 0) {
    logger.warn('Tidak ada GPU yang online saat ini');
    return null;
  }

  // Filter GPU yang online, enabled (ON), dan bertipe public traffic
  const excludeSet = new Set((excludeGpuIds || []).map(String));
  const availableGpus = gpuPool.filter((g) =>
    g.status === 'online' &&
    g.isEnabled !== false &&
    g.mode === 'public' &&
    !excludeSet.has(String(g.id))
  );

  if (availableGpus.length === 0) {
    // Jika semua GPU public dalam exclude list, coba GPU public online mana saja
    logger.warn('Semua GPU public dalam exclude list, mencoba fallback ke GPU public online mana saja...');
    const anyPublicOnline = gpuPool.filter((g) => g.status === 'online' && g.isEnabled !== false && g.mode === 'public');
    if (anyPublicOnline.length === 0) return null;
    return pickFromCandidates(anyPublicOnline);
  }

  return pickFromCandidates(availableGpus);
}

/**
 * Memilih kandidat GPU terbaik berdasarkan total beban efektif & Round-Robin.
 * Dijalankan secara sinkron dan langsung mengunci (increment in-flight) di memori.
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
  roundRobinIndex = (roundRobinIndex + 1) % 1000000;
  const chosenGpu = bestCandidates[chosenIndex];

  // Naikkan counter in-flight secara realtime seketika itu juga (SINKRON)
  incrementInFlight(chosenGpu.id);

  logger.info(
    `[Smart Load Balancer] ⚡ Dispatched ke GPU #${chosenGpu.id} (${chosenGpu.gpuName}) | ` +
    `Queue=${chosenGpu.queueLength}, InFlight=${getInFlight(chosenGpu.id)} | Kandidat Ready=${candidates.length}`
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
  getGpuById,
  setGpuMode,
  isAccessible,
  getQueueLength,
  incrementInFlight,
  decrementInFlight,
  getInFlight,
};


