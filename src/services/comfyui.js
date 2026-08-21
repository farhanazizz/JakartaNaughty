/**
 * ============================================================
 * src/services/comfyui.js — ComfyUI API Client
 * ============================================================
 * Semua komunikasi dengan ComfyUI terpusat di sini:
 *  - Upload gambar source ke ComfyUI
 *  - Load dan modifikasi workflow JSON
 *  - Submit job ke queue ComfyUI
 *  - Polling status job
 *  - Download hasil gambar
 *
 * ComfyUI API endpoints yang digunakan:
 *  POST /upload/image    → upload gambar
 *  POST /prompt          → submit workflow/job
 *  GET  /history/{id}    → cek status job
 *  GET  /view            → download gambar hasil
 * ============================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const FormData = require('form-data');
const { config } = require('../config/env');
const { logger } = require('../utils/logger');

// -------------------------------------------------------
// Load Workflow
// -------------------------------------------------------

/** Cache workflow JSON (dibaca sekali dari disk) */
let cachedWorkflow = null;

/**
 * Membaca file workflow JSON dari disk.
 * Di-cache setelah pertama kali dibaca untuk efisiensi.
 *
 * CATATAN: Workflow ini adalah file yang ada di GPU server,
 * bukan di server website. Kita baca via path yang dikonfigurasi.
 *
 * @returns {Object} Workflow JSON yang sudah di-parse
 * @throws {Error} Jika file tidak ditemukan atau tidak valid JSON
 */
async function loadWorkflow() {
  if (cachedWorkflow) return JSON.parse(JSON.stringify(cachedWorkflow)); // Deep copy

  // Baca file workflow
  const workflowPath = config.comfyui.workflowPath;

  if (!fs.existsSync(workflowPath)) {
    throw new Error(`File workflow tidak ditemukan: ${workflowPath}`);
  }

  const raw = fs.readFileSync(workflowPath, 'utf-8');
  cachedWorkflow = JSON.parse(raw);

  logger.info(`Workflow dimuat dari: ${workflowPath}`);
  return JSON.parse(JSON.stringify(cachedWorkflow)); // Return deep copy
}

// -------------------------------------------------------
// Upload Image
// -------------------------------------------------------

/**
 * Upload gambar source ke ComfyUI server.
 * ComfyUI perlu gambar ada di storage-nya untuk bisa diproses.
 *
 * @param {string} comfyUrl  - URL base ComfyUI (misal: http://ip:port)
 * @param {string} filePath  - Path lengkap file di server website (uploads/)
 * @returns {Promise<string>} Nama file di ComfyUI (untuk dipakai di workflow)
 * @throws {Error} Jika upload gagal
 */
async function uploadImage(comfyUrl, filePath) {
  const filename = path.basename(filePath);

  // Buat FormData dengan file gambar
  const form = new FormData();
  form.append('image', fs.createReadStream(filePath), {
    filename,
    contentType: 'image/jpeg',
  });
  form.append('overwrite', 'true'); // Timpa jika sudah ada

  const res = await fetch(`${comfyUrl}/upload/image`, {
    method: 'POST',
    body: form,
    headers: form.getHeaders(),
    timeout: 30000, // 30 detik timeout untuk upload
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Upload gambar gagal (${res.status}): ${errText}`);
  }

  const data = await res.json();
  logger.debug(`Gambar berhasil diupload ke ComfyUI: ${data.name}`);

  // ComfyUI mengembalikan nama file yang disimpan
  return data.name || filename;
}

// -------------------------------------------------------
// Modifikasi Workflow
// -------------------------------------------------------

/**
 * Mengubah nilai slot dalam workflow JSON.
 * Setiap node dalam workflow punya ID dan widget values.
 *
 * Slot yang kita modifikasi (sesuai workflow Krea2 Edit):
 *  - Node 224: Positive prompt + grounding_px
 *  - Node 228: Negative prompt + grounding_px
 *  - Node 226: Nama file source image
 *  - Node 163: Seed
 *
 * @param {Object} workflow     - Workflow JSON (akan dimodifikasi in-place)
 * @param {string} imageFilename - Nama file gambar yang sudah diupload ke ComfyUI
 * @param {string} positivePrompt - Prompt positif dari user
 * @param {string} negativePrompt - Prompt negatif dari user
 * @param {number} seed          - Seed untuk generate (-1 = random)
 * @returns {Object} Workflow yang sudah dimodifikasi
 */
function modifyWorkflow(workflow, imageFilename, positivePrompt, negativePrompt, seed) {
  // Gunakan seed random jika seed = -1
  const actualSeed = seed === -1
    ? Math.floor(Math.random() * 9999999999)
    : seed;

  // Akses nodes dalam workflow
  // Format workflow ComfyUI: { "node_id": { "inputs": {...}, "class_type": "..." } }
  const nodes = workflow;

  // --- Node 224: Krea2EditGroundedEncode (Positive) ---
  if (nodes['224']) {
    nodes['224'].inputs.prompt = positivePrompt;
    logger.debug(`Node 224 prompt diset: ${positivePrompt.substring(0, 50)}...`);
  }

  // --- Node 228: Krea2EditGroundedEncode (Negative) ---
  if (nodes['228']) {
    nodes['228'].inputs.prompt = negativePrompt || '';
    logger.debug(`Node 228 prompt diset`);
  }

  // --- Node 226: PixaromaLoadImageMini (Source Image) ---
  if (nodes['226']) {
    nodes['226'].inputs.image = imageFilename;
    logger.debug(`Node 226 image diset: ${imageFilename}`);
  }

  // --- Node 163: KSampler (Seed) ---
  if (nodes['163']) {
    nodes['163'].inputs.seed = actualSeed;
    logger.debug(`Node 163 seed diset: ${actualSeed}`);
  }

  return { workflow: nodes, actualSeed };
}

// -------------------------------------------------------
// Submit Job
// -------------------------------------------------------

/**
 * Submit job generate ke ComfyUI.
 * Proses:
 *  1. Load workflow dari file
 *  2. Upload gambar source ke ComfyUI
 *  3. Modifikasi workflow dengan prompt + gambar + seed
 *  4. POST ke /prompt endpoint ComfyUI
 *  5. Return prompt_id untuk tracking
 *
 * @param {string} comfyUrl      - URL base ComfyUI
 * @param {Object} jobParams     - Parameter job
 * @param {string} jobParams.sourceImagePath  - Path file gambar source (di server website)
 * @param {string} jobParams.positivePrompt   - Prompt positif
 * @param {string} jobParams.negativePrompt   - Prompt negatif
 * @param {number} [jobParams.seed=-1]        - Seed (default: random)
 *
 * @returns {Promise<{promptId: string, seed: number}>}
 * @throws {Error} Jika submit gagal
 */
async function submitJob(comfyUrl, { sourceImagePath, positivePrompt, negativePrompt, seed = -1 }) {
  // 1. Load workflow JSON dari disk
  const workflow = await loadWorkflow();

  // 2. Upload gambar source ke ComfyUI
  logger.debug(`Mengupload gambar ke ComfyUI: ${comfyUrl}`);
  const imageFilename = await uploadImage(comfyUrl, sourceImagePath);

  // 3. Modifikasi workflow dengan parameter dari user
  const { workflow: modifiedWorkflow, actualSeed } = modifyWorkflow(
    workflow,
    imageFilename,
    positivePrompt,
    negativePrompt,
    seed
  );

  // 4. Submit ke ComfyUI /prompt endpoint
  const payload = {
    prompt: modifiedWorkflow,
    // client_id unik agar bisa di-track (opsional)
    client_id: `website_${Date.now()}`,
  };

  const res = await fetch(`${comfyUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    timeout: 15000, // 15 detik timeout
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Submit job gagal (${res.status}): ${errText}`);
  }

  const data = await res.json();

  if (!data.prompt_id) {
    throw new Error('ComfyUI tidak mengembalikan prompt_id');
  }

  logger.info(`Job berhasil disubmit ke ComfyUI: prompt_id=${data.prompt_id}`);
  return { promptId: data.prompt_id, seed: actualSeed };
}

// -------------------------------------------------------
// Cek Status Job
// -------------------------------------------------------

/**
 * Mengecek status job di ComfyUI via /history endpoint.
 *
 * Status yang mungkin:
 *  - 'pending'    → Job masih dalam antrian ComfyUI
 *  - 'processing' → Job sedang diproses
 *  - 'done'       → Job selesai, ada output
 *  - 'failed'     → Job gagal
 *
 * @param {string} comfyUrl  - URL base ComfyUI
 * @param {string} promptId  - Prompt ID dari submitJob()
 * @returns {Promise<{status: string, outputFiles: string[]}>}
 */
async function getJobStatus(comfyUrl, promptId) {
  try {
    const res = await fetch(`${comfyUrl}/history/${promptId}`, {
      timeout: 5000,
    });

    if (!res.ok) {
      return { status: 'pending', outputFiles: [] };
    }

    const history = await res.json();

    // Jika prompt ID tidak ada di history → masih pending
    if (!history[promptId]) {
      return { status: 'pending', outputFiles: [] };
    }

    const jobHistory = history[promptId];
    const outputs = jobHistory.outputs || {};

    // Cari output berupa gambar dari semua node
    const outputFiles = [];
    for (const nodeId of Object.keys(outputs)) {
      const nodeOutput = outputs[nodeId];
      if (nodeOutput.images) {
        for (const img of nodeOutput.images) {
          outputFiles.push({
            filename: img.filename,
            subfolder: img.subfolder || '',
            type: img.type || 'output',
          });
        }
      }
    }

    // Cek apakah ada error
    const status = jobHistory.status || {};
    if (status.status_str === 'error' || status.completed === false) {
      const errorMsg = status.messages?.find(m => m[0] === 'execution_error')?.[1]?.exception_message;
      return { status: 'failed', outputFiles: [], error: errorMsg || 'Unknown error' };
    }

    if (outputFiles.length > 0) {
      return { status: 'done', outputFiles };
    }

    return { status: 'processing', outputFiles: [] };

  } catch (err) {
    logger.debug(`Error cek status job ${promptId}: ${err.message}`);
    return { status: 'pending', outputFiles: [] };
  }
}

// -------------------------------------------------------
// Download Output
// -------------------------------------------------------

/**
 * Download gambar hasil dari ComfyUI dan simpan ke folder outputs/.
 *
 * @param {string} comfyUrl   - URL base ComfyUI
 * @param {Object} fileInfo   - Info file dari getJobStatus().outputFiles[0]
 * @param {string} outputPath - Path tujuan di server website (outputs/)
 * @returns {Promise<string>} Path file yang sudah didownload
 * @throws {Error} Jika download gagal
 */
async function downloadOutput(comfyUrl, fileInfo, outputPath) {
  // Build URL untuk download gambar dari ComfyUI
  const params = new URLSearchParams({
    filename: fileInfo.filename,
    type:     fileInfo.type || 'output',
  });
  if (fileInfo.subfolder) {
    params.append('subfolder', fileInfo.subfolder);
  }

  const downloadUrl = `${comfyUrl}/view?${params.toString()}`;

  const res = await fetch(downloadUrl, { timeout: 30000 });
  if (!res.ok) {
    throw new Error(`Download output gagal (${res.status})`);
  }

  // Simpan file ke disk
  const buffer = await res.buffer();
  fs.writeFileSync(outputPath, buffer);

  logger.info(`Output berhasil didownload: ${outputPath}`);
  return outputPath;
}

module.exports = { submitJob, getJobStatus, downloadOutput, loadWorkflow };
