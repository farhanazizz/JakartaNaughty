/**
 * ============================================================
 * src/routes/auth.js — Routes Autentikasi
 * ============================================================
 * Endpoints:
 *   POST /api/auth/login               — Login user
 *   POST /api/auth/logout              — Logout
 *   POST /api/auth/refresh             — Refresh access token
 *   GET  /api/auth/me                  — Info user yang login
 *   GET  /auth/google/admin            — Redirect ke Google OAuth
 *   GET  /auth/google/admin/callback   — Callback dari Google
 * ============================================================
 */

'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../config/database');
const { comparePassword } = require('../utils/hash');
const {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  hashToken,
} = require('../utils/jwt');
const { loginLimiter } = require('../middleware/rateLimiter');
const authMiddleware = require('../middleware/auth');
const passport = require('../config/passport');
const { config } = require('../config/env');
const { logger } = require('../utils/logger');

const router = express.Router();

/**
 * Opsi cookie yang aman:
 * - httpOnly: tidak bisa diakses JavaScript (anti XSS)
 * - secure: hanya HTTPS (di production)
 * - sameSite: strict (anti CSRF)
 */
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure:   config.isProduction,
  sameSite: 'strict',
  path:     '/',
};

// ============================================================
// POST /api/auth/login — Login user biasa
// ============================================================
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validasi input dasar
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ success: false, message: 'Format email tidak valid.' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password minimal 6 karakter.' });
    }

    const db = getDb();

    // Cek apakah user ada di database
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());

    if (!user) {
      // Jangan beritahu apakah email ada atau tidak (security)
      return res.status(401).json({ success: false, message: 'Email atau password salah.' });
    }

    // Cek apakah akun aktif
    if (user.is_active !== 1) {
      return res.status(403).json({ success: false, message: 'Akun kamu dinonaktifkan. Hubungi admin.' });
    }

    // Cek apakah akun sedang terkunci (brute force protection)
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const remaining = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return res.status(403).json({
        success: false,
        message: `Akun terkunci karena terlalu banyak percobaan login. Coba lagi dalam ${remaining} menit.`,
      });
    }

    // Verifikasi password dengan bcrypt
    const isMatch = await comparePassword(password, user.password_hash);

    if (!isMatch) {
      // Increment fail count, lock jika >= 5
      const newFailCount = user.login_fail_count + 1;
      let lockedUntil = null;

      if (newFailCount >= 5) {
        // Lock selama 15 menit
        lockedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        logger.warn(`Akun ${email} dikunci karena ${newFailCount}x gagal login`);
      }

      db.prepare(
        'UPDATE users SET login_fail_count = ?, locked_until = ? WHERE id = ?'
      ).run(newFailCount, lockedUntil, user.id);

      return res.status(401).json({ success: false, message: 'Email atau password salah.' });
    }

    // Login berhasil — reset fail count dan update last_login
    db.prepare(
      'UPDATE users SET login_fail_count = 0, locked_until = NULL, last_login_at = ? WHERE id = ?'
    ).run(new Date().toISOString(), user.id);

    // Buat access token dan refresh token
    const accessToken  = generateAccessToken(user.id, user.role);
    const refreshToken = generateRefreshToken(user.id);

    // Hash refresh token sebelum disimpan ke DB
    const refreshTokenHash = hashToken(refreshToken);

    // Simpan refresh token ke database
    db.prepare(`
      INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at, ip_address)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      user.id,
      refreshTokenHash,
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      new Date().toISOString(),
      req.ip
    );

    // Set cookies HttpOnly
    res.cookie('access_token',  accessToken,  { ...COOKIE_OPTIONS, maxAge: 15 * 60 * 1000 });          // 15 menit
    res.cookie('refresh_token', refreshToken, { ...COOKIE_OPTIONS, maxAge: 7 * 24 * 60 * 60 * 1000 }); // 7 hari

    logger.info(`User login berhasil: ${email} | IP: ${req.ip}`);

    return res.json({
      success: true,
      data: {
        id:      user.id,
        email:   user.email,
        role:    user.role,
        credits: user.credits,
      },
    });

  } catch (err) {
    logger.error('Login error:', err.message);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
});

// ============================================================
// POST /api/auth/logout — Logout
// ============================================================
router.post('/logout', authMiddleware, (req, res) => {
  try {
    const db = getDb();

    // Revoke semua refresh token user ini (logout dari semua perangkat)
    db.prepare(
      'UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL'
    ).run(new Date().toISOString(), req.user.id);

    // Hapus cookies
    res.clearCookie('access_token',  { ...COOKIE_OPTIONS });
    res.clearCookie('refresh_token', { ...COOKIE_OPTIONS });

    logger.info(`User logout: ${req.user.id}`);

    return res.json({ success: true, message: 'Berhasil logout.' });

  } catch (err) {
    logger.error('Logout error:', err.message);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
});

// ============================================================
// POST /api/auth/refresh — Refresh access token
// ============================================================
router.post('/refresh', async (req, res) => {
  try {
    const refreshToken = req.cookies?.refresh_token;

    if (!refreshToken) {
      return res.status(401).json({ success: false, message: 'Tidak ada refresh token.' });
    }

    // Verify refresh token
    let payload;
    try {
      payload = verifyRefreshToken(refreshToken);
    } catch {
      return res.status(401).json({ success: false, message: 'Refresh token tidak valid.' });
    }

    const db = getDb();

    // Cek hash token di database (dan pastikan belum di-revoke)
    const tokenHash   = hashToken(refreshToken);
    const tokenRecord = db.prepare(
      'SELECT * FROM refresh_tokens WHERE token_hash = ? AND revoked_at IS NULL'
    ).get(tokenHash);

    if (!tokenRecord) {
      return res.status(401).json({ success: false, message: 'Refresh token tidak valid atau sudah dicabut.' });
    }

    // Cek apakah token expired di DB
    if (new Date(tokenRecord.expires_at) < new Date()) {
      return res.status(401).json({ success: false, message: 'Refresh token sudah expired.' });
    }

    // Ambil data user terbaru
    const user = db.prepare('SELECT id, role FROM users WHERE id = ? AND is_active = 1').get(payload.sub);
    if (!user) {
      return res.status(401).json({ success: false, message: 'User tidak ditemukan.' });
    }

    // Buat access token baru
    const newAccessToken = generateAccessToken(user.id, user.role);
    res.cookie('access_token', newAccessToken, { ...COOKIE_OPTIONS, maxAge: 15 * 60 * 1000 });

    return res.json({ success: true });

  } catch (err) {
    logger.error('Refresh token error:', err.message);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
});

// ============================================================
// GET /api/auth/me — Info user yang sedang login
// ============================================================
router.get('/me', authMiddleware, (req, res) => {
  const db = getDb();
  const user = db.prepare(
    'SELECT id, email, role, credits FROM users WHERE id = ? AND is_active = 1'
  ).get(req.user.id);

  if (!user) {
    return res.status(404).json({ success: false, message: 'User tidak ditemukan.' });
  }

  return res.json({ success: true, data: user });
});

// ============================================================
// GET /auth/google/admin — Mulai Google OAuth (redirect ke Google)
// ============================================================
router.get('/google/admin', passport.authenticate('google', {
  scope: ['profile', 'email'],
}));

// ============================================================
// GET /auth/google/admin/callback — Callback dari Google
// ============================================================
router.get('/google/admin/callback',
  passport.authenticate('google', {
    failureRedirect: '/admin/login.html?error=unauthorized',
    session: false,  // Kita tidak pakai session Passport, tapi JWT
  }),
  (req, res) => {
    // Jika sampai sini, admin sudah terverifikasi oleh Google dan whitelist
    const adminUser = req.user;

    // Buat access token untuk admin
    const accessToken = generateAccessToken(adminUser.id, adminUser.role);

    // Set cookie — session lebih pendek untuk admin (8 jam)
    res.cookie('access_token', accessToken, {
      ...COOKIE_OPTIONS,
      maxAge: 8 * 60 * 60 * 1000, // 8 jam
    });

    logger.info(`Admin berhasil masuk via Google: ${adminUser.email}`);

    // Redirect ke halaman admin dashboard
    res.redirect('/admin/dashboard.html');
  }
);

module.exports = router;
