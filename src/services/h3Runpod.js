/**
 * src/services/h3Runpod.js â€” MiniMax-H3 (AI Video) RunPod client
 * Separate from Krea photo path (runpod.js / RUNPOD_ENDPOINT_ID).
 * Uses RUNPOD_H3_ENDPOINT_ID only.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { config } = require('../config/env');
const { logger } = require('../utils/logger');

const RUNPOD_API_BASE = 'https://api.runpod.ai/v2';

const WORKFLOW_PATH = path.join(__dirname, '..', 'config', 'h3_workflow.json');

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
 * Build H3 Comfy workflow + images payload from local ref files.
 * @param {Object} opts
 * @param {string[]} opts.refImagePaths - 1..6 local image paths
 * @param {string} opts.prompt
 * @param {number} [opts.durationSec=5]
 * @param {number} [opts.scale=1] - 1=480P, 2=960P
 * @param {number} [opts.seed=-1]
 */
function buildH3Payload({ refImagePaths, prompt, durationSec = 5, scale = 1, seed = -1 }) {
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

  const images = [];
  for (let i = 0; i < nRefs; i++) {
    const srcPath = refImagePaths[i];
    const ext = path.extname(srcPath).toLowerCase().replace('.', '') || 'jpg';
    const name = 'ref_image_' + i + '.' + (ext === 'png' ? 'png' : 'jpg');
    const buf = fs.readFileSync(srcPath);
    const b64 = buf.toString('base64');
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

  return {
    payload: { input: { workflow, images } },
    actualSeed,
    duration,
    modeScale,
    nRefs,
  };
}

async function submitH3Job(opts) {
  const endpointId = getH3EndpointId();
  const apiKey = config.runpod?.apiKey || process.env.RUNPOD_API_KEY;

  if (!apiKey) throw new Error('RUNPOD_API_KEY is not configured');
  if (!endpointId) throw new Error('RUNPOD_H3_ENDPOINT_ID is not configured');

  const { payload, actualSeed, duration, modeScale } = buildH3Payload(opts);
  const submitUrl = `${RUNPOD_API_BASE}/${endpointId}/run`;

  logger.info(`[H3 RunPod] Submitting video job to endpoint ${endpointId} (scale=${modeScale}, ${duration}s)...`);

  const res = await fetch(submitUrl, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(payload),
    timeout: 60000,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`H3 RunPod submit failed (${res.status}): ${errText.substring(0, 400)}`);
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
  const res = await fetch(url, { headers: getHeaders(), timeout: 20000 });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`H3 status check failed (${res.status}): ${errText.substring(0, 300)}`);
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
    throw new Error(`H3 output has no videos/images: ${JSON.stringify(Object.keys(output || {})).substring(0, 200)}`);
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
    logger.info(`[H3 RunPod] Video saved from URL â†’ ${targetPath} (${Math.round(buf.length / 1024)} KB)`);
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
  logger.info(`[H3 RunPod] Video saved â†’ ${targetPath} (${Math.round(buf.length / 1024)} KB)`);
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
};
