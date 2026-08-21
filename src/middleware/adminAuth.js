/**
 * ============================================================
 * src/middleware/adminAuth.js — Middleware Khusus Admin
 * ============================================================
 * Middleware tambahan yang dipasang SETELAH authMiddleware.
 * Memastikan hanya user dengan role 'admin' yang bisa akses.
 *
 * Cara pakai:
 *   router.get('/admin/data', authMiddleware, adminAuthMiddleware, handler)
 *
 * Semua akses ke route admin juga dicatat di log.
 * ============================================================
 */

'use strict';

const { logger } = require('../utils/logger');

/**
 * Middleware untuk memastikan user yang login adalah admin.
 * Harus dipasang SETELAH authMiddleware (butuh req.user).
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function adminAuthMiddleware(req, res, next) {
  // req.user sudah di-set oleh authMiddleware sebelumnya
  if (!req.user || req.user.role !== 'admin') {
    // Log percobaan akses tidak sah — ini penting untuk keamanan
    logger.warn(
      `Percobaan akses admin tidak sah: user=${req.user?.id || 'unknown'} ` +
      `IP=${req.ip} path=${req.path}`
    );

    return res.status(403).json({
      success: false,
      message: 'Akses ditolak. Halaman ini hanya untuk admin.',
    });
  }

  // Log semua akses admin yang berhasil (untuk audit trail)
  logger.info(`Admin akses: id=${req.user.id} path=${req.method} ${req.path} IP=${req.ip}`);

  next();
}

module.exports = adminAuthMiddleware;
