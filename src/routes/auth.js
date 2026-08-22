/**
 * ============================================================
 * src/routes/auth.js — Routes Autentikasi (Username & Password)
 * ============================================================
 * Fitur:
 *   - Login dengan Username atau Email
 *   - Log audit lengkap (User-Agent, IP, Event)
 *   - Proteksi brute-force (lockout 15 menit)
 *   - Proteksi status Suspended
 *   - Cookie aman dengan SameSite Lax
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
const { logSecurityEvent } = require('../utils/securityLogger');
const { logger } = require('../utils/logger');

const router = express.Router();

/**
 * Cookie options:
 * - httpOnly: tidak bisa dibaca JavaScript (anti XSS)
 * - secure: HTTPS di production
 * - sameSite: 'lax' (mencegah cookie hilang saat redirect/navigasi)
 */
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: config.isProduction,
  sameSite: 'lax',
  path: '/',
};

// ============================================================
// POST /api/auth/login — Login Member & Admin (Username/Password)
// ============================================================
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const identifier = (req.body.username || req.body.email || '').toLowerCase().trim();
    const password = req.body.password;

    // Validasi input
    if (!identifier) {
      return res.status(400).json({ success: false, message: 'Username or email is required.' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }

    const db = getDb();

    // Cari user berdasarkan email / username
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(identifier);

    if (!user) {
      logSecurityEvent(req, {
        username: identifier,
        event: 'LOGIN_FAIL_USER_NOT_FOUND',
        status: 'WARNING',
        detail: 'Username not registered',
      });
      return res.status(401).json({ success: false, message: 'Incorrect username or password.' });
    }

    // Cek apakah akun disuspend (is_active === 2)
    if (user.is_active === 2) {
      logSecurityEvent(req, {
        username: identifier,
        event: 'LOGIN_FAIL_SUSPENDED',
        status: 'DANGER',
        detail: 'Login attempt from suspended account',
      });
      return res.status(403).json({
        success: false,
        message: 'Your account has been SUSPENDED by the administrator. Please contact support.',
      });
    }

    // Cek apakah akun nonaktif (is_active === 0)
    if (user.is_active !== 1) {
      logSecurityEvent(req, {
        username: identifier,
        event: 'LOGIN_FAIL_INACTIVE',
        status: 'WARNING',
        detail: 'Login attempt from inactive account',
      });
      return res.status(403).json({ success: false, message: 'Your account is disabled. Please contact admin.' });
    }

    // Cek apakah akun sedang terkunci (brute force lockout)
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const remaining = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      logSecurityEvent(req, {
        username: identifier,
        event: 'LOGIN_FAIL_LOCKED',
        status: 'DANGER',
        detail: `Account locked, ${remaining} mins remaining`,
      });
      return res.status(403).json({
        success: false,
        message: `Account is temporarily locked due to too many failed attempts. Try again in ${remaining} minutes.`,
      });
    }

    // Verifikasi password dengan bcrypt
    const isMatch = await comparePassword(password, user.password_hash);

    if (!isMatch) {
      const newFailCount = (user.login_fail_count || 0) + 1;
      let lockedUntil = null;

      if (newFailCount >= 5) {
        lockedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        logger.warn(`Account ${identifier} locked for 15 minutes (5 failed attempts)`);
      }

      db.prepare(`
        UPDATE users
        SET login_fail_count = ?, locked_until = ?
        WHERE id = ?
      `).run(newFailCount, lockedUntil, user.id);

      logSecurityEvent(req, {
        username: identifier,
        event: lockedUntil ? 'ACCOUNT_LOCKED_BRUTEFORCE' : 'LOGIN_FAIL_WRONG_PASSWORD',
        status: 'WARNING',
        detail: `Failed attempt #${newFailCount}`,
      });

      if (lockedUntil) {
        return res.status(403).json({
          success: false,
          message: 'Password incorrect 5 times. Account locked for 15 minutes.',
        });
      }

      return res.status(401).json({
        success: false,
        message: `Incorrect password. ${5 - newFailCount} attempt(s) remaining.`,
      });
    }


    // Password benar — Reset login_fail_count & update last_login_at
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE users
      SET login_fail_count = 0, locked_until = NULL, last_login_at = ?
      WHERE id = ?
    `).run(now, user.id);

    // Generate token JWT
    const accessToken = generateAccessToken(user.id, user.role);
    const refreshToken = generateRefreshToken(user.id);

    // Simpan hash refresh token ke DB
    const tokenId = uuidv4();
    const tokenHash = hashToken(refreshToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    db.prepare(`
      INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at, ip_address)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(tokenId, user.id, tokenHash, expiresAt, now, req.ip);

    // Set Cookies (Durasi: User = 30 Menit, Admin = 15 Hari)
    const isAdmin = user.role === 'admin';
    const accessCookieMaxAge = isAdmin ? 15 * 24 * 60 * 60 * 1000 : 30 * 60 * 1000;
    const refreshCookieMaxAge = isAdmin ? 30 * 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;

    res.cookie('access_token', accessToken, {
      ...COOKIE_OPTIONS,
      maxAge: accessCookieMaxAge,
    });

    res.cookie('refresh_token', refreshToken, {
      ...COOKIE_OPTIONS,
      maxAge: refreshCookieMaxAge,
    });

    logSecurityEvent(req, {
      username: identifier,
      event: 'LOGIN_SUCCESS',
      status: 'SUCCESS',
      detail: `Role: ${user.role} (Session: ${isAdmin ? '15d' : '30m'})`,
    });

    logger.info(`Login sukses: ${identifier} (role: ${user.role}) IP=${req.ip}`);

    return res.json({
      success: true,
      data: {
        id: user.id,
        username: user.email,
        email: user.email,
        role: user.role,
        credits: user.credits,
      },
    });

  } catch (err) {
    logger.error('Login error:', err);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan saat proses login.' });
  }
});

// ============================================================
// POST /api/auth/logout — Logout
// ============================================================
router.post('/logout', (req, res) => {
  try {
    const refreshToken = req.cookies?.refresh_token;
    if (refreshToken) {
      const db = getDb();
      const tokenHash = hashToken(refreshToken);
      db.prepare(`
        UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ?
      `).run(new Date().toISOString(), tokenHash);
    }
  } catch (_) {}

  res.clearCookie('access_token', { path: '/' });
  res.clearCookie('refresh_token', { path: '/' });

  return res.json({ success: true, message: 'Berhasil logout.' });
});

// ============================================================
// GET /api/auth/me — Info user aktif (Realtime, No-Cache)
// ============================================================
router.get('/me', authMiddleware, (req, res) => {
  try {
    // Header anti-cache ketat agar saldo selalu realtime di browser
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const db = getDb();
    const user = db.prepare(
      'SELECT id, email, role, credits, is_active, created_at, last_login_at FROM users WHERE id = ?'
    ).get(req.user.id);

    if (!user) {
      return res.status(404).json({ success: false, message: 'User tidak ditemukan.' });
    }

    return res.json({
      success: true,
      data: {
        ...user,
        username: user.email,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Gagal memuat profil user.' });
  }
});

// ============================================================
// Google OAuth Admin Callbacks
// ============================================================
router.get('/google/admin', (req, res, next) => {
  if (!config.google.clientId || !config.google.clientSecret) {
    return res.redirect('/admin/login.html?error=oauth_not_configured');
  }
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    prompt: 'select_account',
  })(req, res, next);
});

router.get('/google/admin/callback', (req, res, next) => {
  passport.authenticate('google', (err, user, info) => {
    if (err || !user) {
      logger.warn('Google OAuth admin gagal:', info?.message || err?.message);
      return res.redirect('/admin/login.html?error=unauthorized');
    }

    // Buat JWT untuk admin (15 hari)
    const accessToken = generateAccessToken(user.id, 'admin');
    res.cookie('access_token', accessToken, {
      ...COOKIE_OPTIONS,
      maxAge: 15 * 24 * 60 * 60 * 1000, // 15 hari
    });


    logSecurityEvent(req, {
      username: user.email,
      event: 'OAUTH_ADMIN_LOGIN_SUCCESS',
      status: 'SUCCESS',
      detail: 'Google OAuth',
    });

    return res.redirect('/admin/dashboard.html');
  })(req, res, next);
});

module.exports = router;
