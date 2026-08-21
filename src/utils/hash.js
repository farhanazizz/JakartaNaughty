/**
 * ============================================================
 * src/utils/hash.js — Helper Password Hashing
 * ============================================================
 * Menggunakan bcrypt untuk hash dan verifikasi password.
 * Cost factor 12 = keseimbangan antara keamanan dan performa.
 * (Semakin tinggi cost factor, semakin lambat dan lebih aman)
 * ============================================================
 */

'use strict';

const bcrypt = require('bcryptjs');

// Cost factor bcrypt — 12 adalah standar yang direkomendasikan
const SALT_ROUNDS = 12;

/**
 * Hash password menggunakan bcrypt.
 * Selalu gunakan fungsi ini — JANGAN simpan password plaintext!
 *
 * @param {string} password - Password plaintext dari user
 * @returns {Promise<string>} Password yang sudah di-hash
 */
async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Membandingkan password plaintext dengan hash yang tersimpan di DB.
 * Fungsi ini aman dari timing attack (bcrypt handles internally).
 *
 * @param {string} password     - Password plaintext yang diinput user
 * @param {string} passwordHash - Hash dari database
 * @returns {Promise<boolean>} true jika cocok, false jika tidak
 */
async function comparePassword(password, passwordHash) {
  return bcrypt.compare(password, passwordHash);
}

module.exports = { hashPassword, comparePassword };
