/**
 * ============================================================
 * src/services/comfyui.js — ComfyUI API Client
 * ============================================================
 * Semua komunikasi dengan ComfyUI terpusat di sini:
 *  - Fetch workflow JSON dari GPU server (fallback: file lokal)
 *  - Convert workflow UI format ke API format
 *  - Upload gambar source ke ComfyUI (dengan token auth)
 *  - Submit job ke queue ComfyUI (dengan token auth)
 *  - Polling status job
 *  - Download hasil gambar
 *
 * ComfyUI API endpoints:
 *  GET  /api/userdata/<path> → ambil workflow dari GPU
 *  POST /upload/image        → upload gambar
 *  POST /prompt              → submit workflow/job
 *  GET  /history/{id}        → cek status job
 *  GET  /view                → download gambar hasil
 * ============================================================
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const fetch    = require('node-fetch');
const FormData = require('form-data');
const { config } = require('../config/env');
const { logger } = require('../utils/logger');

// Nama file workflow yang ada di GPU ComfyUI (folder workflows/)
const WORKFLOW_FILENAME = process.env.COMFYUI_WORKFLOW_FILENAME
  || 'Krea 2 + Edit Lora - kapake.json';

// Path file workflow lokal sebagai fallback (src/config/workflow.json)
const LOCAL_WORKFLOW_PATH = path.join(__dirname, '..', 'config', 'workflow.json');

// -------------------------------------------------------
// Helper: token auth
// -------------------------------------------------------

/**
 * Membuat object headers dengan Authorization jika token tersedia.
 */
function makeHeaders(token, extra) {
  const h = Object.assign({}, extra || {});
  if (token) {
    h['Authorization'] = 'Bearer ' + token;
  }
  return h;
}

/**
 * Menambahkan ?token= ke URL untuk auth ComfyUI via query string.
 */
function withToken(url, token) {
  if (!token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + 'token=' + encodeURIComponent(token);
}

// -------------------------------------------------------
// Load Workflow (GPU atau Lokal)
// -------------------------------------------------------

/**
 * Mengambil workflow JSON dari GPU ComfyUI.
 * Endpoint: GET /api/userdata/workflows%2F<filename>
 *
 * @param {string} comfyUrl - URL base ComfyUI
 * @param {string} token    - jupyter_token dari Vast.ai
 * @returns {Object|null} Workflow dalam UI format, atau null jika gagal
 */
async function fetchWorkflowFromGpu(comfyUrl, token) {
  try {
    // Format path yang benar untuk ComfyUI 0.33.x:
    // /api/userdata/workflows%2F<encoded-filename>
    const encodedPath = 'workflows%2F' + encodeURIComponent(WORKFLOW_FILENAME);
    const url = comfyUrl + '/api/userdata/' + encodedPath;

    const res = await fetch(url, {
      headers: makeHeaders(token),
      timeout: 8000,
    });

    if (!res.ok) {
      logger.warn('Gagal fetch workflow dari GPU (' + res.status + '): ' + url);
      return null;
    }

    const wf = await res.json();

    if (!wf || (!wf.nodes && !wf.prompt)) {
      logger.warn('Workflow dari GPU tidak valid (tidak ada nodes/prompt)');
      return null;
    }

    logger.info('Workflow berhasil diambil dari GPU: ' + WORKFLOW_FILENAME);
    return wf;

  } catch (err) {
    logger.warn('Fetch workflow dari GPU error: ' + err.message);
    return null;
  }
}

/**
 * Membaca workflow dari file lokal (fallback).
 * File: src/config/workflow.json
 *
 * @returns {Object} Workflow JSON
 * @throws {Error} Jika file tidak ada
 */
function loadLocalWorkflow() {
  if (!fs.existsSync(LOCAL_WORKFLOW_PATH)) {
    throw new Error('File workflow lokal tidak ditemukan: ' + LOCAL_WORKFLOW_PATH);
  }
  const raw = fs.readFileSync(LOCAL_WORKFLOW_PATH, 'utf-8');
  const wf  = JSON.parse(raw);
  logger.info('Workflow dimuat dari lokal: ' + LOCAL_WORKFLOW_PATH);
  return wf;
}

/**
 * Convert workflow dari UI format (nodes array) ke API format (dict by node ID).
 *
 * ComfyUI /prompt membutuhkan format:
 *   { "<node_id>": { "class_type": "...", "inputs": { ... } } }
 *
 * Tapi workflow yang tersimpan di GPU/disk dalam UI format:
 *   { "nodes": [{ "id": 1, "type": "KSampler", ... }], "links": [...] }
 *
 * @param {Object} uiWorkflow - Workflow dalam UI format
 * @returns {Object} Workflow dalam API format untuk POST /prompt
 */
function convertUiToApiFormat(uiWorkflow) {
  // Jika sudah API format (ada key 'prompt')
  if (uiWorkflow.prompt) {
    return JSON.parse(JSON.stringify(uiWorkflow.prompt));
  }

  if (!uiWorkflow.nodes || !Array.isArray(uiWorkflow.nodes)) {
    throw new Error('Format workflow tidak dikenali (tidak ada nodes/prompt)');
  }

  // Build link map: link_id -> { srcNode, srcSlot }
  const linkMap = {};
  for (const link of (uiWorkflow.links || [])) {
    // Format: [id, src_node, src_slot, dst_node, dst_slot, type]
    const linkId  = link[0];
    const srcNode = link[1];
    const srcSlot = link[2];
    linkMap[linkId] = { srcNode, srcSlot };
  }

  const apiFormat = {};

  for (const node of uiWorkflow.nodes) {
    // Skip node yang disabled (mode !== 0)
    if (node.mode !== 0) continue;

    const nodeId    = String(node.id);
    const classType = node.type;
    const inputs    = {};

    // 1. Widget values (named) — lebih reliable daripada positional
    if (node.widgets_values_named) {
      const namedVals = node.widgets_values_named;
      for (const key of Object.keys(namedVals)) {
        // Skip field UI-only dari Pixaroma custom nodes
        if (key.includes('_ui') || key === 'upload' || key === 'LoadImageMiniState') continue;
        inputs[key] = namedVals[key];
      }
    }

    // 2. Linked inputs (koneksi antar node dalam workflow)
    for (const inp of (node.inputs || [])) {
      if (inp.link == null) continue; // Tidak ada koneksi

      const link = linkMap[inp.link];
      if (!link) continue;

      // Format link di API: [source_node_id, source_slot_index]
      inputs[inp.name] = [String(link.srcNode), link.srcSlot];
    }

    apiFormat[nodeId] = {
      class_type: classType,
      inputs,
    };
  }

  return apiFormat;
}

/**
 * Load workflow dan convert ke API format.
 * Coba dari GPU terlebih dahulu, fallback ke file lokal.
 *
 * @param {string} comfyUrl - URL ComfyUI
 * @param {string} token    - Token auth
 * @returns {Object} Workflow dalam API format
 */
async function loadWorkflowApiFormat(comfyUrl, token) {
  // Coba ambil dari GPU
  let uiWorkflow = await fetchWorkflowFromGpu(comfyUrl, token);

  // Fallback ke file lokal
  if (!uiWorkflow) {
    logger.warn('Menggunakan workflow lokal sebagai fallback...');
    uiWorkflow = loadLocalWorkflow();
  }

  return convertUiToApiFormat(uiWorkflow);
}

// -------------------------------------------------------
// Upload Image (dengan token auth)
// -------------------------------------------------------

/**
 * Upload gambar source ke ComfyUI server dengan token auth.
 *
 * @param {string} comfyUrl  - URL base ComfyUI
 * @param {string} filePath  - Path file di server website (uploads/)
 * @param {string} token     - Token auth Vast.ai
 * @returns {Promise<string>} Nama file di ComfyUI
 * @throws {Error} Jika upload gagal
 */
async function uploadImage(comfyUrl, filePath, token) {
  const filename = path.basename(filePath);

  const form = new FormData();
  form.append('image', fs.createReadStream(filePath), {
    filename,
    contentType: 'image/jpeg',
  });
  form.append('overwrite', 'true');

  // Token via URL dan header
  const uploadUrl = withToken(comfyUrl + '/upload/image', token);
  const headers   = Object.assign(form.getHeaders(), makeHeaders(token));

  const res = await fetch(uploadUrl, {
    method:  'POST',
    body:    form,
    headers: headers,
    timeout: 30000,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error('Upload gambar gagal (' + res.status + '): ' + errText);
  }

  const data = await res.json();
  logger.debug('Gambar berhasil diupload ke ComfyUI: ' + (data.name || filename));
  return data.name || filename;
}

// -------------------------------------------------------
// Modifikasi Workflow
// -------------------------------------------------------

/**
 * Memodifikasi workflow API format dengan parameter dari user.
 *
 * Node yang dimodifikasi (struktur workflow Krea 2 + Edit Lora):
 *  - Node 224: Krea2EditGroundedEncode (Positive prompt)
 *  - Node 228: Krea2EditGroundedEncode (Negative prompt, collapsed)
 *  - Node 226: PixaromaLoadImageMini   (Source image)
 *  - Node 163: KSampler               (Seed)
 *
 * @param {Object} apiWorkflow    - Workflow API format
 * @param {string} imageFilename  - Nama file gambar di ComfyUI
 * @param {string} positivePrompt - Prompt positif
 * @param {string} negativePrompt - Prompt negatif
 * @param {number} seed           - Seed (-1 = random)
 * @returns {{ workflow: Object, actualSeed: number }}
 */
function modifyWorkflow(apiWorkflow, imageFilename, positivePrompt, negativePrompt, seed) {
  const actualSeed = (seed === -1 || seed == null)
    ? Math.floor(Math.random() * 9999999999)
    : seed;

  const nodes = apiWorkflow;

  // Node 224: Positive prompt
  if (nodes['224'] && nodes['224'].inputs !== undefined) {
    nodes['224'].inputs.prompt = positivePrompt;
    logger.debug('Node 224 prompt diset: ' + positivePrompt.substring(0, 50));
  }

  // Node 228: Negative prompt
  if (nodes['228'] && nodes['228'].inputs !== undefined) {
    nodes['228'].inputs.prompt = negativePrompt || '';
    logger.debug('Node 228 negative prompt diset');
  }

  // Node 226: Source image
  if (nodes['226'] && nodes['226'].inputs !== undefined) {
    nodes['226'].inputs.image = imageFilename;
    logger.debug('Node 226 image diset: ' + imageFilename);
  }

  // Node 163: Seed
  if (nodes['163'] && nodes['163'].inputs !== undefined) {
    nodes['163'].inputs.seed = actualSeed;
    logger.debug('Node 163 seed diset: ' + actualSeed);
  }

  return { workflow: nodes, actualSeed };
}

// -------------------------------------------------------
// Submit Job
// -------------------------------------------------------

/**
 * Submit job generate ke ComfyUI.
 * Proses:
 *  1. Load workflow dari GPU (fallback lokal)
 *  2. Upload gambar source ke ComfyUI
 *  3. Modifikasi workflow dengan prompt + gambar + seed
 *  4. POST ke /prompt endpoint ComfyUI
 *  5. Return prompt_id untuk tracking
 *
 * @param {string} comfyUrl   - URL base ComfyUI
 * @param {Object} jobParams  - Parameter job
 * @param {string} jobParams.sourceImagePath  - Path file gambar source
 * @param {string} jobParams.positivePrompt   - Prompt positif
 * @param {string} jobParams.negativePrompt   - Prompt negatif
 * @param {number} [jobParams.seed=-1]        - Seed (default: random)
 * @param {string} [jobParams.token='']       - Token auth Vast.ai (jupyter_token)
 *
 * @returns {Promise<{promptId: string, seed: number}>}
 * @throws {Error} Jika submit gagal
 */
async function submitJob(comfyUrl, { sourceImagePath, positivePrompt, negativePrompt, seed = -1, token = '' }) {
  // 1. Load workflow dalam API format (GPU atau lokal)
  logger.debug('Memuat workflow untuk GPU: ' + comfyUrl);
  const apiWorkflow = await loadWorkflowApiFormat(comfyUrl, token);

  // 2. Upload gambar source ke ComfyUI
  logger.debug('Mengupload gambar ke ComfyUI: ' + comfyUrl);
  const imageFilename = await uploadImage(comfyUrl, sourceImagePath, token);

  // 3. Modifikasi workflow
  const { workflow: modifiedWorkflow, actualSeed } = modifyWorkflow(
    apiWorkflow,
    imageFilename,
    positivePrompt,
    negativePrompt,
    seed
  );

  // 4. Submit ke ComfyUI /prompt endpoint
  const payload = {
    prompt:    modifiedWorkflow,
    client_id: 'jn_' + Date.now(),
  };

  const promptUrl = withToken(comfyUrl + '/prompt', token);

  const res = await fetch(promptUrl, {
    method:  'POST',
    headers: makeHeaders(token, { 'Content-Type': 'application/json' }),
    body:    JSON.stringify(payload),
    timeout: 20000,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error('Submit job gagal (' + res.status + '): ' + errText.substring(0, 500));
  }

  const data = await res.json();

  if (!data.prompt_id) {
    throw new Error('ComfyUI tidak mengembalikan prompt_id. Response: ' + JSON.stringify(data).substring(0, 300));
  }

  logger.info('Job berhasil disubmit ke ComfyUI: prompt_id=' + data.prompt_id);
  return { promptId: data.prompt_id, seed: actualSeed };
}

// -------------------------------------------------------
// Cek Status Job
// -------------------------------------------------------

/**
 * Mengecek status job di ComfyUI via /history endpoint.
 *
 * @param {string} comfyUrl   - URL base ComfyUI
 * @param {string} promptId   - Prompt ID dari submitJob()
 * @param {string} [token=''] - Token auth
 * @returns {Promise<{status: string, outputFiles: Array, error?: string}>}
 */
async function getJobStatus(comfyUrl, promptId, token) {
  token = token || '';
  try {
    const historyUrl = withToken(comfyUrl + '/history/' + promptId, token);
    const res = await fetch(historyUrl, {
      headers: makeHeaders(token),
      timeout: 8000,
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
    const outputs    = jobHistory.outputs || {};

    // Cari output berupa gambar dari semua node
    const outputFiles = [];
    for (const nodeId of Object.keys(outputs)) {
      const nodeOutput = outputs[nodeId];
      if (nodeOutput.images) {
        for (const img of nodeOutput.images) {
          outputFiles.push({
            filename:  img.filename,
            subfolder: img.subfolder || '',
            type:      img.type || 'output',
          });
        }
      }
    }

    // Cek apakah ada error
    const statusObj = jobHistory.status || {};
    if (statusObj.status_str === 'error' || statusObj.completed === false) {
      const errorMsg = statusObj.messages
        && statusObj.messages.find(function(m) { return m[0] === 'execution_error'; });
      return {
        status:      'failed',
        outputFiles: [],
        error:       (errorMsg && errorMsg[1] && errorMsg[1].exception_message) || 'Unknown ComfyUI error',
      };
    }

    if (outputFiles.length > 0) {
      return { status: 'done', outputFiles };
    }

    return { status: 'processing', outputFiles: [] };

  } catch (err) {
    logger.debug('Error cek status job ' + promptId + ': ' + err.message);
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
 * @param {string} [token=''] - Token auth
 * @returns {Promise<string>} Path file yang sudah didownload
 * @throws {Error} Jika download gagal
 */
async function downloadOutput(comfyUrl, fileInfo, outputPath, token) {
  token = token || '';
  const params = new URLSearchParams({
    filename: fileInfo.filename,
    type:     fileInfo.type || 'output',
  });
  if (fileInfo.subfolder) {
    params.append('subfolder', fileInfo.subfolder);
  }

  const downloadUrl = withToken(comfyUrl + '/view?' + params.toString(), token);

  const res = await fetch(downloadUrl, {
    headers: makeHeaders(token),
    timeout: 60000,
  });

  if (!res.ok) {
    throw new Error('Download output gagal (' + res.status + ')');
  }

  const buffer = await res.buffer();
  fs.writeFileSync(outputPath, buffer);

  logger.info('Output berhasil didownload: ' + outputPath);
  return outputPath;
}

module.exports = { submitJob, getJobStatus, downloadOutput, loadWorkflowApiFormat };
