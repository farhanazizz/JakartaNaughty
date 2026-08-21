/**
 * ============================================================
 * src/middleware/auth.js — Middleware Autentikasi JWT
 * ============================================================
 * Middleware ini melindungi semua route yang membutuhkan login.
 * Cara kerja:
 *  1. Ambil access token dari HttpOnly cookie 'access_token'
 *  2. Verifikasi token (cek tanda tangan dan expired)
 *  3. Attach data user ke req.user
 *  4. Lanjut ke handler berikutnya
 *
 * Jika token tidak ada atau invalid → return 401 Unauthorized
 * ============================================================
 */

'use strict';

const { verifyAccessToken } = require('../utils/jwt');
const { logger } = require('../utils/logger');

/**
 * Middleware untuk memverifikasi JWT dari cookie.
 * Pasang di route yang perlu login:
 *   router.get('/protected', authMiddleware, handler)
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function authMiddleware(req, res, next) {
  // Ambil access token dari HttpOnly cookie
  const token = req.cookies?.access_token;

  // Jika tidak ada token → belum login
  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Akses ditolak. Silakan login terlebih dahulu.',
    });
  }

  try {
    // Verifikasi dan decode token JWT
    const payload = verifyAccessToken(token);

    // Verifikasi status user di database secara realtime
    const { getDb } = require('../config/database');
    const db = getDb();
    const user = db.prepare('SELECT is_active, email FROM users WHERE id = ?').get(payload.sub);

    if (!user || user.is_active !== 1) {
      res.clearCookie('access_token');
      res.clearCookie('refresh_token');
      return res.status(403).json({
        success: false,
        message: user?.is_active === 2
          ? 'Akun Anda telah DITANGGUHKAN (SUSPENDED) oleh administrator.'
          : 'Akun Anda tidak aktif atau telah dinonaktifkan.',
      });
    }

    // Simpan data user ke request untuk dipakai di handler
    req.user = {
      id:    payload.sub,   // User ID
      role:  payload.role,  // 'user' atau 'admin'
      email: user.email,
    };

    // Token valid, lanjut ke handler berikutnya
    next();
  } catch (err) {
    // Token invalid atau expired
    logger.debug(`Auth gagal: ${err.message}`);

    // Bersihkan cookie yang invalid
    res.clearCookie('access_token');

    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Sesi habis. Silakan login ulang.',
        code: 'TOKEN_EXPIRED', // Frontend bisa cek ini untuk auto-refresh
      });
    }

    return res.status(401).json({
      success: false,
      message: 'Token tidak valid. Silakan login ulang.',
    });
  }
}

module.exports = authMiddleware;
