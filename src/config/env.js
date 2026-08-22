/**
 * ============================================================
 * src/config/env.js — Validasi Environment Variables
 * ============================================================
 * File ini memastikan semua environment variables yang dibutuhkan
 * sudah di-set sebelum server dijalankan. Jika ada yang missing,
 * server akan langsung berhenti dengan pesan error yang jelas.
 *
 * Cara pakai: import/require di awal server.js
 * ============================================================
 */

'use strict';

require('dotenv').config();

/**
 * Daftar environment variables yang WAJIB ada.
 * Jika salah satu tidak di-set, server tidak akan jalan.
 */
const REQUIRED_VARS = [
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'SESSION_SECRET',
  'VASTAI_API_KEY',
];

/**
 * Validasi semua required environment variables.
 * Dipanggil sekali saat startup.
 */
function validateEnv() {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.error('❌ ERROR: Environment variables berikut belum di-set:');
    missing.forEach((key) => console.error(`   - ${key}`));
    console.error('\n📋 Salin file .env.example ke .env dan isi semua nilainya.');
    process.exit(1); // Hentikan server dengan kode error
  }

  // Peringatan jika masih pakai nilai default/contoh
  if (process.env.JWT_SECRET === 'ganti-dengan-string-random-yang-panjang-sekali') {
    console.warn('⚠️  PERINGATAN: JWT_SECRET masih menggunakan nilai default! Ganti segera.');
  }
}

/**
 * Konfigurasi terpusat — semua config diambil dari sini.
 * Memudahkan pencarian dan perubahan nilai default.
 */
const config = {
  // Server
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',

  // JWT
  jwt: {
    secret: process.env.JWT_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    accessExpire: process.env.JWT_ACCESS_EXPIRE || '15m',
    refreshExpire: process.env.JWT_REFRESH_EXPIRE || '7d',
  },

  // Session (untuk Google OAuth)
  session: {
    secret: process.env.SESSION_SECRET,
  },

  // Google OAuth
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackUrl: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/auth/google/admin/callback',
  },

  // Branding
  app: {
    name: 'Jakarta Naughty',
    studio: 'Edit Photo Studio',
  },

  // Admin — daftar email & secret key gerbang penyamaran (Stealth Shield)
  adminSecretKey: process.env.ADMIN_SECRET_KEY || 'jakarta_naughty_admin_secret_key_88',
  adminEmails: (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),

  // Vast.ai
  vastai: {
    apiKey: process.env.VASTAI_API_KEY,
    baseUrl: 'https://console.vast.ai/api/v0',
    cacheTtlSeconds: parseInt(process.env.GPU_CACHE_TTL_SECONDS || '30', 10),
  },

  // ComfyUI
  comfyui: {
    port: parseInt(process.env.COMFYUI_PORT || '18188', 10),
    workflowPath: process.env.COMFYUI_WORKFLOW_PATH ||
      '/workspace/ComfyUI/user/default/workflows/Krea 2 + Edit Lora - kapake.json',
  },

  // Job Queue
  jobs: {
    maxConcurrentPerUser: parseInt(process.env.MAX_CONCURRENT_JOBS_PER_USER || '3', 10),
    timeoutMinutes: parseInt(process.env.JOB_TIMEOUT_MINUTES || '10', 10),
  },

  // Upload
  upload: {
    maxSizeMb: parseInt(process.env.UPLOAD_MAX_SIZE_MB || '10', 10),
    allowedMimeTypes: ['image/jpeg', 'image/png'],
    uploadDir: process.env.UPLOAD_DIR || 'uploads',
    outputDir: process.env.OUTPUT_DIR || 'outputs',
  },

  // Cloudflare R2 Storage (S3-Compatible)
  r2: {
    accountId: process.env.R2_ACCOUNT_ID || '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    bucketName: process.env.R2_BUCKET_NAME || 'jakartanaughty',
    publicDomain: (process.env.R2_PUBLIC_DOMAIN || '').replace(/\/+$/, ''),
    isConfigured: Boolean(
      process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET_NAME
    ),
  },
};

module.exports = { validateEnv, config };

