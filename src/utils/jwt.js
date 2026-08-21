/**
 * ============================================================
 * src/utils/jwt.js — Helper JWT (JSON Web Token)
 * ============================================================
 * Semua operasi JWT terpusat di sini:
 *  - Generate access token (umur pendek: 15 menit)
 *  - Generate refresh token (umur panjang: 7 hari)
 *  - Verify token
 *  - Hash token (untuk disimpan aman di database)
 *
 * Access token dikirim via HttpOnly cookie ke browser.
 * Refresh token juga di cookie HttpOnly, hash-nya di DB.
 * ============================================================
 */

'use strict';

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { config } = require('../config/env');

/**
 * Membuat access token JWT untuk user yang login.
 * Token ini berumur pendek (15 menit) untuk keamanan.
 *
 * @param {string} userId - ID user dari database
 * @param {string} role   - Role user: 'user' atau 'admin'
 * @returns {string} JWT access token
 */
function generateAccessToken(userId, role) {
  return jwt.sign(
    {
      sub: userId, // subject = user ID
      role,        // role untuk cek otorisasi
    },
    config.jwt.secret,
    { expiresIn: config.jwt.accessExpire }
  );
}

/**
 * Membuat refresh token JWT.
 * Token ini berumur panjang (7 hari) dan disimpan hash-nya di DB.
 * Dipakai untuk mendapatkan access token baru tanpa harus login ulang.
 *
 * @param {string} userId - ID user dari database
 * @returns {string} JWT refresh token
 */
function generateRefreshToken(userId) {
  return jwt.sign(
    { sub: userId },
    config.jwt.refreshSecret,
    { expiresIn: config.jwt.refreshExpire }
  );
}

/**
 * Memverifikasi access token.
 * Lempar error jika token invalid atau expired.
 *
 * @param {string} token - JWT access token
 * @returns {{ sub: string, role: string, iat: number, exp: number }} payload
 * @throws {Error} jika token invalid atau expired
 */
function verifyAccessToken(token) {
  return jwt.verify(token, config.jwt.secret);
}

/**
 * Memverifikasi refresh token.
 *
 * @param {string} token - JWT refresh token
 * @returns {{ sub: string, iat: number, exp: number }} payload
 * @throws {Error} jika token invalid atau expired
 */
function verifyRefreshToken(token) {
  return jwt.verify(token, config.jwt.refreshSecret);
}

/**
 * Membuat hash SHA-256 dari token untuk disimpan di database.
 * Kita TIDAK menyimpan token asli di DB — hanya hash-nya.
 * Ini agar jika DB bocor, token tidak bisa langsung dipakai.
 *
 * @param {string} token - Token asli (plaintext)
 * @returns {string} SHA-256 hex hash
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  hashToken,
};
