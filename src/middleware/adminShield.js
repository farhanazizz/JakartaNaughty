/**
 * ============================================================
 * src/middleware/adminShield.js — Admin Stealth Gate (Anti-Scanning)
 * ============================================================
 * Melindungi semua URL admin (/admin/*, /api/admin/*) dari bot scanning,
 * hacker, dan akses publik tanpa izin.
 *
 * Mengembalikan 404 Not Found murni jika tidak memiliki Secret Key.
 * ============================================================
 */

'use strict';

const crypto = require('crypto');
const { config } = require('../config/env');
const { verifyAccessToken } = require('../utils/jwt');
const { logSecurityEvent } = require('../utils/securityLogger');
const { logger } = require('../utils/logger');

// Hash secret key untuk verifikasi cookie gate
function getGateSecretHash() {
  return crypto.createHash('sha256').update(config.adminSecretKey).digest('hex');
}

/**
 * Middleware penyamaran admin.
 * Mengembalikan 404 Not Found jika tidak memiliki kunci gerbang admin.
 */
function adminShield(req, res, next) {
  const secretKey = config.adminSecretKey;
  const providedKey = req.query.key || req.headers['x-admin-key'];
  const gateCookie = req.cookies?.admin_gate_token;
  const gateHash = getGateSecretHash();

  // 1. Cek apakah ada secret key valid di query string (?key=...) atau header
  if (providedKey && providedKey.trim() === secretKey) {
    res.cookie('admin_gate_token', gateHash, {
      httpOnly: true,
      secure: config.isProduction,
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000, // 24 jam
      path: '/',
    });
    return next();
  }

  // 2. Cek apakah memiliki cookie gate yang valid
  if (gateCookie === gateHash) {
    return next();
  }

  // 3. Cek apakah sudah login sebagai admin (via JWT access_token cookie)
  const token = req.cookies?.access_token;
  if (token) {
    const payload = verifyAccessToken(token);
    if (payload && payload.role === 'admin') {
      return next();
    }
  }

  // 4. Jika bukan admin dan tidak punya secret key -> CATAT KE SECURITY LOG & KEMBALIKAN 404
  logSecurityEvent(req, {
    username: 'unauthorized_scanner',
    event: 'STEALTH_GATE_BLOCKED',
    status: 'DANGER',
    detail: { path: req.originalUrl, method: req.method },
  });

  logger.warn(`[STEALTH SHIELD] Akses admin ditolak (404 fake): IP=${req.ip} path=${req.originalUrl}`);

  if (req.path.startsWith('/api/')) {
    return res.status(404).json({
      success: false,
      message: 'Cannot ' + req.method + ' ' + req.path,
    });
  }

  // 404 generik sederhana untuk request browser
  return res.status(404).type('text/html').send(`
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="utf-8"><title>404 Not Found</title></head>
    <body style="font-family:sans-serif;text-align:center;padding:100px 20px;background:#0f172a;color:#94a3b8;">
      <h1 style="font-size:48px;color:#f8fafc;margin-bottom:8px;">404</h1>
      <p style="font-size:18px;">Page not found.</p>
    </body>
    </html>
  `);
}

module.exports = { adminShield, getGateSecretHash };
