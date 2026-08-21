/**
 * ============================================================
 * src/utils/logger.js — Utility Logging
 * ============================================================
 * Logger sederhana dengan level: info, warn, error, debug.
 * Format output: [TIMESTAMP] [LEVEL] pesan
 *
 * Di production (NODE_ENV=production), debug logs tidak ditampilkan.
 * ============================================================
 */

'use strict';

// Warna untuk terminal (ANSI escape codes)
const COLORS = {
  reset:  '\x1b[0m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  green:  '\x1b[32m',
  blue:   '\x1b[34m',
  cyan:   '\x1b[36m',
};

/**
 * Format timestamp saat ini dalam format yang mudah dibaca.
 * @returns {string} contoh: "2026-08-21 15:30:45"
 */
function getTimestamp() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

/**
 * Fungsi logger utama — format dan tampilkan pesan ke console.
 * @param {string} level - Level log ('INFO', 'WARN', 'ERROR', 'DEBUG')
 * @param {string} color - Kode warna ANSI
 * @param {...any} args  - Pesan atau objek yang akan di-log
 */
function log(level, color, ...args) {
  const timestamp = `${COLORS.dim}[${getTimestamp()}]${COLORS.reset}`;
  const levelTag  = `${color}[${level}]${COLORS.reset}`;
  console.log(timestamp, levelTag, ...args);
}

/**
 * Kumpulan fungsi logger yang bisa dipakai di seluruh aplikasi.
 */
const logger = {
  /**
   * Log informasi umum (server start, koneksi DB, dll).
   * @param {...any} args
   */
  info: (...args) => log('INFO ', COLORS.green, ...args),

  /**
   * Log peringatan — sesuatu yang perlu diperhatikan tapi tidak fatal.
   * @param {...any} args
   */
  warn: (...args) => log('WARN ', COLORS.yellow, ...args),

  /**
   * Log error — sesuatu yang salah dan perlu segera ditangani.
   * @param {...any} args
   */
  error: (...args) => log('ERROR', COLORS.red, ...args),

  /**
   * Log debug — detail teknis untuk debugging.
   * HANYA tampil di development (NODE_ENV !== 'production').
   * @param {...any} args
   */
  debug: (...args) => {
    if (process.env.NODE_ENV !== 'production') {
      log('DEBUG', COLORS.cyan, ...args);
    }
  },
};

module.exports = { logger };
