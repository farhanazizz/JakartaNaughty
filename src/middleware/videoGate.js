/**
 * AI Video access gate — server-side password + HttpOnly cookie.
 * Password never shipped to the browser.
 */
'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { config } = require('../config/env');

const COOKIE = () => config.videoGate?.cookieName || 'video_gate';

function passwordConfigured() {
  return Boolean(config.videoGate?.password);
}

function safePasswordMatch(input) {
  const expected = String(config.videoGate?.password || '');
  const got = String(input || '');
  const a = crypto.createHash('sha256').update(expected, 'utf8').digest();
  const b = crypto.createHash('sha256').update(got, 'utf8').digest();
  return crypto.timingSafeEqual(a, b) && expected.length > 0;
}

function signVideoGateToken(userId) {
  const days = Math.max(1, config.videoGate?.cookieDays || 7);
  return jwt.sign(
    { purpose: 'video_gate', sub: String(userId || 'member') },
    config.jwt.secret,
    { expiresIn: days + 'd' }
  );
}

function verifyVideoGateToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, config.jwt.secret);
    if (payload.purpose !== 'video_gate') return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function setVideoGateCookie(res, token) {
  const days = Math.max(1, config.videoGate?.cookieDays || 7);
  res.cookie(COOKIE(), token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    maxAge: days * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function clearVideoGateCookie(res) {
  res.clearCookie(COOKIE(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    path: '/',
  });
}

function hasValidVideoGate(req) {
  return Boolean(verifyVideoGateToken(req.cookies?.[COOKIE()]));
}

/**
 * Express middleware — blocks API if video gate cookie missing/invalid.
 */
function requireVideoGate(req, res, next) {
  if (!passwordConfigured()) {
    // Fail closed if misconfigured in production; allow in dev only with warning
    if (config.isProduction) {
      return res.status(503).json({ success: false, message: 'Video access is not configured.' });
    }
  }
  if (!hasValidVideoGate(req)) {
    return res.status(403).json({
      success: false,
      code: 'VIDEO_GATE_REQUIRED',
      message: 'AI Video password required.',
    });
  }
  return next();
}

module.exports = {
  passwordConfigured,
  safePasswordMatch,
  signVideoGateToken,
  verifyVideoGateToken,
  setVideoGateCookie,
  clearVideoGateCookie,
  hasValidVideoGate,
  requireVideoGate,
  COOKIE,
};
