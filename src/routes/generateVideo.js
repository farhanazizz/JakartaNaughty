/**
 * src/routes/generateVideo.js â€” POST /api/generate-video
 * AI Video (MiniMax-H3). Does not touch Photo Creator /api/generate.
 */
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../config/database');
const { deductCredit, addCredit } = require('../services/creditService');
const { enqueueVideoJob } = require('../services/jobQueue');
const { generateLimiter } = require('../middleware/rateLimiter');
const authMiddleware = require('../middleware/auth');
const { requireVideoGate } = require('../middleware/videoGate');
const { config } = require('../config/env');
const { logger } = require('../utils/logger');
const { videoCreditsForScale, getH3EndpointId } = require('../services/h3Runpod');

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.upload.uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${uuidv4()}${ext}`);
  },
});

function fileFilter(req, file, cb) {
  if (['image/jpeg', 'image/png'].includes(file.mimetype)) cb(null, true);
  else cb(new Error(`Unsupported file type: ${file.mimetype}. JPEG/PNG only.`), false);
}

const uploadRefs = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: config.upload.maxSizeMb * 1024 * 1024,
    files: 6,
  },
}).array('ref_images', 6);

function uploadVideoRefs(req, res, next) {
  uploadRefs(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({
            success: false,
            message: `File too large. Max ${config.upload.maxSizeMb}MB per image.`,
          });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          return res.status(400).json({
            success: false,
            message: 'Maximum 6 reference images allowed.',
          });
        }
        return res.status(400).json({ success: false, message: `Upload error: ${err.message}` });
      }
      return res.status(400).json({ success: false, message: err.message });
    }
    return next();
  });
}

function cleanupFiles(files) {
  (files || []).forEach((f) => {
    try { fs.unlinkSync(f.path); } catch (_) {}
  });
}

/**
 * POST /api/generate-video
 * multipart: ref_images (1-6), prompt, duration (5-15), scale (1|2), seed optional
 * Credits: 480P=max(3,dur), 960P=max(6,dur*2)
 */
router.post(
  '/',
  authMiddleware,
  requireVideoGate,
  generateLimiter,
  uploadVideoRefs,
  async (req, res) => {
    const userId = req.user.id;
    const files = req.files || [];

    try {
      if (!getH3EndpointId()) {
        cleanupFiles(files);
        return res.status(503).json({
          success: false,
          message: 'AI Video endpoint is not configured (RUNPOD_H3_ENDPOINT_ID).',
        });
      }

      if (files.length < 1) {
        return res.status(400).json({
          success: false,
          message: 'At least 1 reference image is required (up to 6).',
        });
      }

      const prompt = (req.body.prompt || req.body.positive_prompt || '').trim();
      if (!prompt || prompt.length < 5) {
        cleanupFiles(files);
        return res.status(400).json({
          success: false,
          message: 'Prompt/dialog is required (min 5 characters). Use [Picture 1]/[Picture 2]/[Picture 3] refs.',
        });
      }

      const durationSec = Math.max(5, Math.min(15, parseInt(req.body.duration, 10) || 5));
      const scale = String(req.body.scale || req.body.resolution || '1').trim() === '2' ||
        String(req.body.scale || '').toLowerCase() === '960p'
        ? 2
        : 1;
      const seed = parseInt(req.body.seed, 10);
      const creditsNeeded = videoCreditsForScale(scale, durationSec);

      const db = getDb();
      const user = db.prepare('SELECT credits FROM users WHERE id = ? AND is_active = 1').get(userId);
      if (!user) {
        cleanupFiles(files);
        return res.status(403).json({ success: false, message: 'User account not found.' });
      }
      if (user.credits < creditsNeeded) {
        cleanupFiles(files);
        return res.status(403).json({
          success: false,
          message: `Insufficient credits. AI Video needs ${creditsNeeded} credit(s); you have ${user.credits}.`,
        });
      }

      const deductResult = deductCredit(
        userId,
        creditsNeeded,
        `AI Video (${scale === 2 ? '960P' : '480P'}, ${durationSec}s)`
      );
      if (!deductResult.success) {
        cleanupFiles(files);
        return res.status(403).json({
          success: false,
          message: deductResult.message || 'Failed to deduct credits.',
        });
      }

      let enqueueResult;
      try {
        enqueueResult = enqueueVideoJob(userId, {
          refImagePaths: files.map((f) => f.path),
          refImageNames: files.map((f) => f.originalname),
          prompt,
          durationSec,
          scale,
          seed: Number.isFinite(seed) ? seed : -1,
          creditsUsed: creditsNeeded,
        });
      } catch (enqueueErr) {
        logger.error(`Video enqueue failed user=${userId}: ${enqueueErr.message}`);
        addCredit(userId, creditsNeeded, 'Refund: video queue submission failed', null);
        cleanupFiles(files);
        return res.status(500).json({
          success: false,
          message: enqueueErr.message || 'Failed to queue video job.',
        });
      }

      logger.info(
        `AI Video queued: user=${userId} jobId=${enqueueResult.jobId} scale=${scale} duration=${durationSec}s credits=${creditsNeeded}`
      );

      return res.json({
        success: true,
        data: {
          jobId: enqueueResult.jobId,
          queuePosition: enqueueResult.queuePosition,
          creditsUsed: creditsNeeded,
          message: `Video job queued. Position: #${enqueueResult.queuePosition}`,
        },
      });
    } catch (err) {
      logger.error('generateVideo route error:', err.message);
      cleanupFiles(files);
      return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
  }
);

module.exports = router;
