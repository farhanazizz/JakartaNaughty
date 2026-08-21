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
    // Verifikasi dan decode token
    const payload = verifyAccessToken(token);

    // Simpan data user ke request untuk dipakai di handler
    req.user = {
      id:    payload.sub,   // User ID
      role:  payload.role,  // 'user' atau 'admin'
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
