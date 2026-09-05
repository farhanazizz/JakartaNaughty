/**
 * ============================================================
 * src/middleware/rateLimiter.js — Rate Limiting
 * ============================================================
 * Membatasi jumlah request per IP untuk mencegah:
 *  - Brute force attack pada endpoint login
 *  - Abuse pada endpoint generate (spam job)
 *  - DDoS sederhana
 *
 * Menggunakan express-rate-limit dengan in-memory store.
 * ============================================================
 */

'use strict';

const rateLimit = require('express-rate-limit');

/**
 * Rate limiter untuk endpoint LOGIN.
 * Sangat ketat: 5 percobaan per 15 menit per IP.
 * Mencegah brute force attack pada password.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // Window: 15 menit
  max: 5,                    // Maksimal 5 request per window
  standardHeaders: true,     // Return info rate limit di header RateLimit-*
  legacyHeaders: false,

  // Pesan error yang dikembalikan saat limit terlampaui
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: 'Terlalu banyak percobaan login. Coba lagi dalam 15 menit.',
    });
  },
});

/**
 * Rate limiter untuk endpoint GENERATE.
 * Sedang: 10 request per menit per IP.
 * Mencegah spam job generate.
 */
const generateLimiter = rateLimit({
  windowMs: 60 * 1000, // Window: 1 menit
  max: 10,             // Maksimal 10 request per menit
  standardHeaders: true,
  legacyHeaders: false,

  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: 'Terlalu banyak request generate. Tunggu sebentar.',
    });
  },
});

/**
 * Rate limiter UMUM untuk semua API endpoint.
 * Longgar: 100 request per menit per IP.
 * Mencegah abuse umum.
 */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // Window: 1 menit
  max: 100,            // Maksimal 100 request per menit
  standardHeaders: true,
  legacyHeaders: false,

  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: 'Terlalu banyak request. Tunggu sebentar.',
    });
  },
});


/**
 * Rate limiter for AI Video password unlock.
 * Tight: 5 attempts / 15 minutes / IP (brute-force resistant).
 */
const videoGateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: 'Too many password attempts. Try again in 15 minutes.',
    });
  },
});

module.exports = {loginLimiter, generateLimiter, apiLimiter,
  videoGateLimiter,
};
