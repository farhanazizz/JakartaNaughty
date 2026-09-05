/**
 * src/services/h3Runpod.js — MiniMax-H3 (AI Video) RunPod client
 * Separate from Krea photo path (runpod.js / RUNPOD_ENDPOINT_ID).
 * Uses RUNPOD_H3_ENDPOINT_ID only.
 *
 * Reference images are compressed with sharp before base64 embedding so the
 * JSON body stays under RunPod's ~10MiB limit.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const sharp = require('sharp');
const { config } = require('../config/env');
const { logger } = require('../utils/logger');

const RUNPOD_API_BASE = 'https://api.runpod.ai/v2';
const WORKFLOW_PATH = path.join(__dirname, '..', 'config', 'h3_workflow.json');

/** Soft budget under RunPod's hard 10MiB body limit */
const MAX_RUNPOD_BODY_BYTES = 9 * 1024 * 1024;
/** Base64 expands binary by ~4/3; usable binary fraction of remaining budget */
const BASE64_BINARY_FRACTION = 0.72;

/**
 * Video credit formula (must match UI creditsNeeded()):
 *   480P: max(3, durationSec)     e.g. 3s=3, 5s=5, 10s=10
 *   960P: max(6, durationSec * 2) e.g. 3s=6, 5s=10, 10s=20
 * Duration clamped 5..15 to match generateVideo / H3 payload.
 */
const VIDEO_CREDITS_480P_MIN = 3;
const VIDEO_CREDITS_960P_MIN = 6;
const VIDEO_CREDITS_480P = VIDEO_CREDITS_480P_MIN;
const VIDEO_CREDITS_960P = VIDEO_CREDITS_960P_MIN;

function getHeaders() {
  const apiKey = config.runpod?.apiKey || process.env.RUNPOD_API_KEY;
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

function getH3EndpointId() {
  return (
    config.runpod?.h3EndpointId ||
    process.env.RUNPOD_H3_ENDPOINT_ID ||
    ''
  );
}

function videoCreditsForScale(scale, durationSec) {
  const d = Math.max(5, Math.min(15, parseInt(durationSec, 10) || 5));
  if (Number(scale) === 2) return Math.max(VIDEO_CREDITS_960P_MIN, d * 2);
  return Math.max(VIDEO_CREDITS_480P_MIN, d);
}

function loadH3WorkflowTemplate() {
  const raw = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  return JSON.parse(raw);
}

/**
 * Compress one reference image to JPEG under a binary byte budget.
 * Pipeline: EXIF rotate → resize max edge (no enlarge) → mozjpeg quality ladder.
 * Falls back to max edge 1024 @ q=40 if still over budget.
 * @param {string} srcPath
 * @param {number} maxBinaryBytes
 * @returns {Promise<Buffer>}
 */
async function compressRefImage(srcPath, maxBinaryBytes) {
  const input = fs.readFileSync(srcPath);
  const qualities = [82, 72, 62, 52, 40];
  let lastBuf = null;

  async function encode(maxEdge, quality) {
    return sharp(input)
      .rotate() // honour EXIF orientation
      .resize({
        width: maxEdge,
        height: maxEdge,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
  }

  for (const q of qualities) {
    lastBuf = await encode(1536, q);
    if (lastBuf.length <= maxBinaryBytes) {
      logger.info(
        `[H3 RunPod] Compressed ref ${path.basename(srcPath)} → ${Math.round(lastBuf.length / 1024)} KB (edge=1536 q=${q})`
      );
      return lastBuf;
    }
  }

  // Still over budget: tighter resize
  lastBuf = await encode(1024, 40);
  if (lastBuf.length <= maxBinaryBytes) {
    logger.info(
      `[H3 RunPod] Compressed ref ${path.basename(srcPath)} → ${Math.round(lastBuf.length / 1024)} KB (edge=1024 q=40)`
    );
    return lastBuf;
  }

  logger.warn(
    `[H3 RunPod] Ref ${path.basename(srcPath)} still ${Math.round(lastBuf.length / 1024)} KB after min quality (budget ${Math.round(maxBinaryBytes / 1024)} KB); using best effort`
  );
  return lastBuf;
}

/**
 * Friendly RunPod HTTP error (no raw HTML/Cloudflare pages in user-facing message).
 * Raw details are logged via logger.error.
 */
function friendlyRunPodHttpError(status, errText, context) {
  const snippet = String(errText || '').substring(0, 500);
  logger.error(`[H3 RunPod] ${context} HTTP ${status}: ${snippet}`);

  const lower = snippet.toLowerCase();
  if (
    status === 413 ||
    lower.includes('exceeded max body size') ||
    lower.includes('request entity too large') ||
    lower.includes('payload too large')
  ) {
    return new Error(
      'Reference images are too large for the video service after compression. Please use fewer or smaller photos and try again.'
    );
  }
  if (
    status === 502 ||
    status === 503 ||
    status === 504 ||
    lower.includes('cloudflare') ||
    lower.includes('<!doctype html')
  ) {
    return new Error(
      'The video service is temporarily unavailable (gateway error). Please try again in a moment.'
    );
  }
  if (status === 401 || status === 403) {
    return new Error(
      'Video service authentication failed. Please contact support if this continues.'
    );
  }
  return new Error(`Video service request failed (HTTP ${status}). Please try again.`);
}

/**
 * Build H3 Comfy workflow + images payload from local ref files.
 * Compresses each ref to JPEG so JSON.stringify(payload) stays under MAX_RUNPOD_BODY_BYTES.
 * @param {Object} opts
 * @param {string[]} opts.refImagePaths - 1..6 local image paths
 * @param {string} opts.prompt
 * @param {number} [opts.durationSec=5]
 * @param {number} [opts.scale=1] - 1=480P, 2=960P
 * @param {number} [opts.seed=-1]
 */
async function buildH3Payload({ refImagePaths, prompt, durationSec = 5, scale = 1, seed = -1 }) {
  if (!Array.isArray(refImagePaths) || refImagePaths.length < 1) {
    throw new Error('At least 1 reference image is required for AI Video');
  }
  if (refImagePaths.length > 6) {
    throw new Error('Maximum 6 reference images allowed');
  }

  const workflow = loadH3WorkflowTemplate();
  const duration = Math.max(5, Math.min(15, Number(durationSec) || 5));
  const modeScale = Number(scale) === 2 ? 2 : 1;
  const nRefs = refImagePaths.length;

  if (workflow['365'] && workflow['365'].inputs) {
    workflow['365'].inputs.prompt = String(prompt || '').trim();
  }
  if (workflow['22:23'] && workflow['22:23'].inputs) {
    workflow['22:23'].inputs.value = duration;
  }
  if (workflow['243'] && workflow['243'].inputs) {
    workflow['243'].inputs['mode.scale'] = modeScale;
  }

  const actualSeed =
    seed === -1 || seed === null || seed === undefined
      ? Math.floor(Math.random() * 1e15)
      : Number(seed);
  if (workflow['16'] && workflow['16'].inputs) workflow['16'].inputs.value = actualSeed;
  if (workflow['103'] && workflow['103'].inputs) {
    workflow['103'].inputs.value = Math.floor(Math.random() * 1e15);
  }

  const loadNodes = ['123', '151', '152', '153', '154', '155'];

  if (workflow['5'] && workflow['5'].inputs) {
    Object.keys(workflow['5'].inputs).forEach((k) => {
      if (k.startsWith('ref_images.')) delete workflow['5'].inputs[k];
    });
  }
  if (workflow['366'] && workflow['366'].inputs) {
    Object.keys(workflow['366'].inputs).forEach((k) => {
      if (k.startsWith('pictures.')) delete workflow['366'].inputs[k];
    });
  }

  // Estimate workflow overhead (no images yet) to split binary budget across refs
  const overheadPayload = { input: { workflow, images: [] } };
  const overheadBytes = Buffer.byteLength(JSON.stringify(overheadPayload), 'utf8');
  const remaining = Math.max(256 * 1024, MAX_RUNPOD_BODY_BYTES - overheadBytes);
  // Per-ref binary budget after base64 expansion (~0.72 of remaining)
  const perRefBinaryBudget = Math.floor((remaining * BASE64_BINARY_FRACTION) / nRefs);

  logger.info(
    `[H3 RunPod] Payload budget: overhead=${Math.round(overheadBytes / 1024)} KB, per-ref binary≈${Math.round(perRefBinaryBudget / 1024)} KB (n=${nRefs})`
  );

  const images = [];
  for (let i = 0; i < nRefs; i++) {
    const srcPath = refImagePaths[i];
    const name = 'ref_image_' + i + '.jpg';
    const jpegBuf = await compressRefImage(srcPath, perRefBinaryBudget);
    const b64 = jpegBuf.toString('base64');
    const nodeId = loadNodes[i];

    if (workflow[nodeId] && workflow[nodeId].inputs) {
      workflow[nodeId].inputs.image = name;
    }
    if (workflow['5'] && workflow['5'].inputs) {
      workflow['5'].inputs['ref_images.ref_image_' + i] = [nodeId, 0];
    }
    if (workflow['366'] && workflow['366'].inputs) {
      workflow['366'].inputs['pictures.<Picture ' + (i + 1) + '>'] = [nodeId, 0];
    }
    images.push({ name, image: b64 });
  }

  for (let i = nRefs; i < loadNodes.length; i++) {
    delete workflow[loadNodes[i]];
  }

  let payload = { input: { workflow, images } };
  let bodyBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');

  if (bodyBytes > MAX_RUNPOD_BODY_BYTES) {
    // Second pass: force edge 1024 q=40 for every ref
    logger.warn(
      `[H3 RunPod] Payload ${Math.round(bodyBytes / 1024)} KB exceeds ${Math.round(MAX_RUNPOD_BODY_BYTES / 1024)} KB; recompressing all refs at edge=1024 q=40`
    );
    for (let i = 0; i < nRefs; i++) {
      const jpegBuf = await sharp(fs.readFileSync(refImagePaths[i]))
        .rotate()
        .resize({
          width: 1024,
          height: 1024,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: 40, mozjpeg: true })
        .toBuffer();
      images[i].image = jpegBuf.toString('base64');
      images[i].name = 'ref_image_' + i + '.jpg';
    }
    payload = { input: { workflow, images } };
    bodyBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  }

  if (bodyBytes > MAX_RUNPOD_BODY_BYTES) {
    throw new Error(
      'Reference images are too large for the video service after compression. Please use fewer or smaller photos and try again.'
    );
  }

  logger.info(
    `[H3 RunPod] Final payload size: ${Math.round(bodyBytes / 1024)} KB (limit ${Math.round(MAX_RUNPOD_BODY_BYTES / 1024)} KB)`
  );

  return {
    payload,
    actualSeed,
    duration,
    modeScale,
    nRefs,
    bodyBytes,
  };
}

async function submitH3Job(opts) {
  const endpointId = getH3EndpointId();
  const apiKey = config.runpod?.apiKey || process.env.RUNPOD_API_KEY;

  if (!apiKey) throw new Error('RUNPOD_API_KEY is not configured');
  if (!endpointId) throw new Error('RUNPOD_H3_ENDPOINT_ID is not configured');

  const { payload, actualSeed, duration, modeScale, bodyBytes } = await buildH3Payload(opts);
  const submitUrl = `${RUNPOD_API_BASE}/${endpointId}/run`;

  logger.info(
    `[H3 RunPod] Submitting video job to endpoint ${endpointId} (scale=${modeScale}, ${duration}s, body=${Math.round((bodyBytes || 0) / 1024)} KB)...`
  );

  let res;
  try {
    res = await fetch(submitUrl, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(payload),
      timeout: 60000,
    });
  } catch (netErr) {
    logger.error(`[H3 RunPod] Network error on submit: ${netErr.message}`);
    throw new Error('Could not reach the video service. Please check your connection and try again.');
  }

  if (!res.ok) {
    const errText = await res.text();
    throw friendlyRunPodHttpError(res.status, errText, 'submit');
  }

  const data = await res.json();
  if (!data.id) {
    throw new Error(`H3 RunPod did not return job id: ${JSON.stringify(data).substring(0, 300)}`);
  }

  logger.info(`[H3 RunPod] Submitted: runpodJobId=${data.id}`);
  return { runpodJobId: data.id, actualSeed, duration, modeScale };
}

async function getH3JobStatus(runpodJobId) {
  const endpointId = getH3EndpointId();
  const url = `${RUNPOD_API_BASE}/${endpointId}/status/${runpodJobId}`;
  let res;
  try {
    res = await fetch(url, { headers: getHeaders(), timeout: 20000 });
  } catch (netErr) {
    logger.error(`[H3 RunPod] Network error on status: ${netErr.message}`);
    throw new Error('Could not reach the video service while checking job status. Please try again.');
  }
  if (!res.ok) {
    const errText = await res.text();
    throw friendlyRunPodHttpError(res.status, errText, 'status');
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
 * Save videos[0] (preferred) or images[0] from H3 output to targetPath (.mp4).
 */
async function saveH3OutputVideo(output, targetPath) {
  if (!output) throw new Error('H3 output is empty');

  let item = null;
  if (Array.isArray(output.videos) && output.videos.length > 0) {
    item = output.videos[0];
  } else if (Array.isArray(output.images) && output.images.length > 0) {
    item = output.images[0];
  }

  if (!item) {
    throw new Error(
      `H3 output has no videos/images: ${JSON.stringify(Object.keys(output || {})).substring(0, 200)}`
    );
  }

  let raw = item.data || item.image || item.url || null;

  // URL download path
  if (typeof raw === 'string' && /^https?:\/\//i.test(raw)) {
    const dl = await fetch(raw, { timeout: 120000 });
    if (!dl.ok) throw new Error(`Failed to download H3 video URL (${dl.status})`);
    const buf = Buffer.from(await dl.arrayBuffer());
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(targetPath, buf);
    logger.info(`[H3 RunPod] Video saved from URL → ${targetPath} (${Math.round(buf.length / 1024)} KB)`);
    return targetPath;
  }

  if (!raw || typeof raw !== 'string') {
    throw new Error(`Unrecognized H3 video payload keys: ${Object.keys(item).join(',')}`);
  }

  if (raw.includes(',')) raw = raw.split(',')[1];
  const buf = Buffer.from(raw, 'base64');
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(targetPath, buf);
  logger.info(`[H3 RunPod] Video saved → ${targetPath} (${Math.round(buf.length / 1024)} KB)`);
  return targetPath;
}

module.exports = {
  submitH3Job,
  getH3JobStatus,
  saveH3OutputVideo,
  getH3EndpointId,
  videoCreditsForScale,
  VIDEO_CREDITS_480P,
  VIDEO_CREDITS_960P,
  buildH3Payload,
  MAX_RUNPOD_BODY_BYTES,
};
