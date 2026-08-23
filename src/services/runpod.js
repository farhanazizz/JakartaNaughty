/**
 * ============================================================
 * src/services/runpod.js — RunPod Serverless Client
 * ============================================================
 * Service ini menangani integrasi penuh dengan RunPod Serverless:
 *  1. Submit workflow ComfyUI ke RunPod Serverless API (/run & /runsync)
 *  2. Mengirimkan gambar source (Base64 atau CDN URL)
 *  3. Polling status job (/status/{id}) hingga selesai
 *  4. Mengambil gambar hasil generate (Base64/URL) dan menyimpan ke Cloudflare R2
 *  5. Health check & monitoring status worker endpoint
 * ============================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { config } = require('../config/env');
const { logger } = require('../utils/logger');
const { loadWorkflowApiFormat, modifyWorkflow } = require('./comfyui');

/** Base URL API RunPod Serverless */
const RUNPOD_API_BASE = 'https://api.runpod.ai/v2';

/**
 * Helper untuk headers autentikasi RunPod
 */
function getHeaders() {
  const apiKey = config.runpod?.apiKey || process.env.RUNPOD_API_KEY;
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

/**
 * Mendapatkan Endpoint ID RunPod yang aktif
 */
function getEndpointId() {
  return config.runpod?.endpointId || process.env.RUNPOD_ENDPOINT_ID || 'kwhjwi2di095sq';
}

/**
 * Mengecek status kesehatan RunPod Serverless Endpoint (Worker & Queue).
 * @returns {Promise<Object>}
 */
async function getEndpointHealth() {
  const endpointId = getEndpointId();
  try {
    const url = `${RUNPOD_API_BASE}/${endpointId}/health`;
    const res = await fetch(url, {
      headers: getHeaders(),
      timeout: 6000,
    });

    if (!res.ok) {
      return {
        online: false,
        message: `HTTP ${res.status} dari RunPod API`,
        endpointId,
      };
    }

    const data = await res.json();
    const readyWorkers = data?.workers?.ready || 0;
    const idleWorkers = data?.workers?.idle || 0;
    const inProgress = data?.jobs?.inProgress || 0;
    const inQueue = data?.jobs?.inQueue || 0;

    return {
      online: true,
      endpointId,
      workers: {
        ready: readyWorkers,
        idle: idleWorkers,
        running: data?.workers?.running || 0,
      },
      jobs: {
        inProgress,
        inQueue,
        completed: data?.jobs?.completed || 0,
        failed: data?.jobs?.failed || 0,
      },
      message: readyWorkers > 0 || idleWorkers > 0 ? 'Worker Siap' : 'Scale to Zero (Standby)',
    };
  } catch (err) {
    logger.warn('Gagal cek health RunPod Endpoint:', err.message);
    return {
      online: false,
      endpointId,
      message: `Koneksi gagal: ${err.message}`,
    };
  }
}

/**
 * Submit job generate ke RunPod Serverless.
 *
 * @param {Object} params
 * @param {string} params.sourceImagePath   - Path file gambar di server lokal
 * @param {string} params.positivePrompt    - Prompt positif
 * @param {string} params.negativePrompt    - Prompt negatif
 * @param {number} [params.seed=-1]         - Seed
 * @param {number} [params.refBoost=4.2]    - Fidelity Reference Boost
 * @param {string} [params.resolution='1mp'] - Resolusi (1mp atau 2mp)
 * @returns {Promise<{ runpodJobId: string, actualSeed: number }>}
 */
async function submitRunPodJob({ sourceImagePath, positivePrompt, negativePrompt, seed = -1, refBoost = 4.2, resolution = '1mp' }) {
  const endpointId = getEndpointId();
  const apiKey = config.runpod?.apiKey || process.env.RUNPOD_API_KEY;

  if (!apiKey) {
    throw new Error('RUNPOD_API_KEY belum dikonfigurasi di .env');
  }

  // 1. Load workflow ComfyUI dalam format API
  const baseApiWorkflow = await loadWorkflowApiFormat('', '');

  // 2. Baca file gambar source dan encode ke Base64 Data URI
  const filename = path.basename(sourceImagePath);
  const ext = path.extname(sourceImagePath).replace('.', '').toLowerCase();
  const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
  const imgBuffer = fs.readFileSync(sourceImagePath);
  const imgBase64 = `data:${mimeType};base64,${imgBuffer.toString('base64')}`;

  // 3. Injeksi prompt, LoRA, refBoost, resolution, dan seed ke workflow
  const { workflow: modifiedWorkflow, actualSeed } = modifyWorkflow(
    baseApiWorkflow,
    filename,
    positivePrompt,
    negativePrompt,
    seed,
    refBoost,
    resolution
  );

  // 4. Pastikan node-node inti Krea2 tervalidasi
  if (modifiedWorkflow['195']) {
    // CLIPLoader tipe krea2 untuk Qwen3-VL
    modifiedWorkflow['195'].inputs = {
      clip_name: 'qwen3-vl-4b-heretic.safetensors',
      type: 'krea2',
      device: 'default',
    };
  }

  if (modifiedWorkflow['194']) {
    // Diffusion Model Moody Krea 2 Mix
    modifiedWorkflow['194'].inputs = {
      unet_name: 'moodyKrea2Mix_v70BF16.safetensors',
      weight_dtype: 'default',
    };
  }

  // 5. Bersihkan node-node UI murni (PixaromaLabel, PixaromaNote, dll) yang tidak dibutuhkan headless ComfyUI
  const cleanWorkflow = {};
  for (const [nodeId, nodeData] of Object.entries(modifiedWorkflow)) {
    const classType = nodeData.class_type;
    // Skip node anotasi UI saja
    if (classType === 'PixaromaLabel' || classType === 'PixaromaNote' || classType === 'PixaromaCompare') {
      continue;
    }
    cleanWorkflow[nodeId] = nodeData;
  }

  // 6. Susun payload standar RunPod ComfyUI Worker
  const payload = {
    input: {
      workflow: cleanWorkflow,
      images: [
        {
          name: filename,
          image: imgBase64,
        },
      ],
    },
  };

  const submitUrl = `${RUNPOD_API_BASE}/${endpointId}/run`;
  logger.info(`[RunPod Serverless] Mengirim job ke endpoint ${endpointId}...`);

  const res = await fetch(submitUrl, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(payload),
    timeout: 30000,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`RunPod submit gagal (${res.status}): ${errText}`);
  }

  const data = await res.json();

  if (!data.id) {
    throw new Error(`RunPod tidak mengembalikan job ID: ${JSON.stringify(data)}`);
  }

  logger.info(`[RunPod Serverless] ✅ Job berhasil disubmit: runpodJobId=${data.id}`);
  return {
    runpodJobId: data.id,
    actualSeed,
  };
}

/**
 * Mengecek status eksekusi job di RunPod Serverless.
 *
 * @param {string} runpodJobId - ID job dari RunPod
 * @returns {Promise<{ status: 'IN_QUEUE'|'IN_PROGRESS'|'COMPLETED'|'FAILED', output?: any, error?: string, executionTime?: number }>}
 */
async function getRunPodJobStatus(runpodJobId) {
  const endpointId = getEndpointId();
  const url = `${RUNPOD_API_BASE}/${endpointId}/status/${runpodJobId}`;

  const res = await fetch(url, {
    headers: getHeaders(),
    timeout: 10000,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Cek status RunPod gagal (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return {
    status: data.status,
    output: data.output,
    error: data.error,
    executionTime: data.executionTime,
  };
}

/**
 * Menyimpan gambar hasil output dari RunPod Serverless ke file lokal.
 *
 * @param {Object} output - Output object dari RunPod
 * @param {string} targetPath - Path file lokal untuk menyimpan PNG
 */
async function saveRunPodOutputImage(output, targetPath) {
  if (!output) {
    throw new Error('Output dari RunPod kosong');
  }

  let imgBase64 = null;

  if (output.images && Array.isArray(output.images) && output.images.length > 0) {
    const imgObj = output.images[0];
    imgBase64 = imgObj.image || imgObj.data || imgObj;
  } else if (output.image) {
    imgBase64 = output.image;
  } else if (output.message && typeof output.message === 'string' && output.message.startsWith('data:image')) {
    imgBase64 = output.message;
  }

  if (!imgBase64 || typeof imgBase64 !== 'string') {
    throw new Error(`Format output RunPod tidak dikenali: ${JSON.stringify(output).substring(0, 200)}`);
  }

  // Buang prefix data:image/...;base64, jika ada
  if (imgBase64.includes(',')) {
    imgBase64 = imgBase64.split(',')[1];
  }

  const buf = Buffer.from(imgBase64, 'base64');
  const targetDir = path.dirname(targetPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  fs.writeFileSync(targetPath, buf);
  logger.info(`[RunPod Serverless] Gambar output berhasil disimpan ke ${targetPath} (${Math.round(buf.length / 1024)} KB)`);
  return targetPath;
}

module.exports = {
  submitRunPodJob,
  getRunPodJobStatus,
  saveRunPodOutputImage,
  getEndpointHealth,
  getEndpointId,
};
