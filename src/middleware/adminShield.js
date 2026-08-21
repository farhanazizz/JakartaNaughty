/**
 * ============================================================
 * src/middleware/adminShield.js — Admin Stealth Gate (Anti-Scanning)
 * ============================================================
 * Melindungi semua URL admin (/admin/*, /api/admin/*, /admin/login.html)
 * dari bot scanning, hacker, dan akses publik tanpa izin.
 *
 * Logika:
 * 1. Jika user sudah login dengan token admin valid -> IZINKAN
 * 2. Jika request menyertakan Secret Key yang valid (?key=... atau header X-Admin-Key) -> IZINKAN & set gate cookie
 * 3. Jika request memiliki gate cookie valid -> IZINKAN
 * 4. Jika TIDAK memenuhi -> Kembalikan 404 Not Found murni (seolah-olah URL admin tidak ada)
 * ============================================================
 */

'use strict';

const crypto = require('crypto');
const { config } = require('../config/env');
const { verifyAccessToken } = require('../utils/jwt');
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
  if (providedKey && providedKey === secretKey) {
    // Beri cookie gate agar admin tidak perlu memasukkan query ?key= di setiap klik
    res.cookie('admin_gate_token', gateHash, {
      httpOnly: true,
      secure: config.isProduction,
      sameSite: 'lax',
      maxAge: 4 * 60 * 60 * 1000, // 4 jam
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

  // 4. Jika bukan admin dan tidak punya secret key -> KEMBALIKAN 404 NOT FOUND MURNI
  logger.warn(`[STEALTH SHIELD] Akses admin ditolak (404 fake): IP=${req.ip} path=${req.originalUrl}`);

  if (req.path.startsWith('/api/')) {
    return res.status(404).json({
      success: false,
      message: 'Cannot ' + req.method + ' ' + req.path,
    });
  }

  // Tampilkan 404 generik sederhana untuk request halaman HTML
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
