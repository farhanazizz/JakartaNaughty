/**
 * POST /api/video-gate/unlock — verify shared password, set HttpOnly cookie
 * GET  /api/video-gate/status — unlocked?
 * POST /api/video-gate/lock   — clear cookie
 */
'use strict';

const express = require('express');
const authMiddleware = require('../middleware/auth');
const { videoGateLimiter } = require('../middleware/rateLimiter');
const {
  passwordConfigured,
  safePasswordMatch,
  signVideoGateToken,
  setVideoGateCookie,
  clearVideoGateCookie,
  hasValidVideoGate,
} = require('../middleware/videoGate');
const { logger } = require('../utils/logger');

const router = express.Router();

router.get('/status', authMiddleware, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    success: true,
    data: {
      configured: passwordConfigured(),
      unlocked: hasValidVideoGate(req),
    },
  });
});

router.post('/unlock', authMiddleware, videoGateLimiter, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!passwordConfigured()) {
    return res.status(503).json({ success: false, message: 'Video password is not configured on server.' });
  }
  const password = req.body?.password;
  if (typeof password !== 'string' || password.length < 1 || password.length > 200) {
    return res.status(400).json({ success: false, message: 'Password required.' });
  }
  if (!safePasswordMatch(password)) {
    logger.warn(`Video gate failed unlock user=${req.user?.id} ip=${req.ip}`);
    return res.status(401).json({ success: false, message: 'Wrong password.' });
  }
  const token = signVideoGateToken(req.user.id);
  setVideoGateCookie(res, token);
  logger.info(`Video gate unlocked user=${req.user.id}`);
  return res.json({ success: true, data: { unlocked: true } });
});

router.post('/lock', authMiddleware, (req, res) => {
  clearVideoGateCookie(res);
  return res.json({ success: true, data: { unlocked: false } });
});

module.exports = router;
