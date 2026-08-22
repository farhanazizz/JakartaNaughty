/**
 * ============================================================
 * src/services/r2Storage.js — Cloudflare R2 Cloud Object Storage
 * ============================================================
 * Service ini menangani penyimpanan gambar ke Cloudflare R2:
 *  - Upload hasil generate ke Cloudflare R2 bucket
 *  - Generate CDN public URL berkecepatan tinggi ($0 egress fee)
 *  - Hapus file otomatis (retensi 3 hari / lifecycle management)
 *  - Fallback aman ke disk lokal jika R2 belum dikonfigurasi
 * ============================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { config } = require('../config/env');
const { logger } = require('../utils/logger');

let s3Client = null;

/**
 * Inisialisasi S3 Client untuk Cloudflare R2
 */
function getS3Client() {
  if (s3Client) return s3Client;

  if (!config.r2.isConfigured) {
    logger.warn('Cloudflare R2 belum lengkap dikonfigurasi. Menggunakan fallback penyimpanan lokal.');
    return null;
  }

  try {
    s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.r2.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.r2.accessKeyId,
        secretAccessKey: config.r2.secretAccessKey,
      },
    });

    logger.info(`Cloudflare R2 Client terhubung ke bucket: ${config.r2.bucketName}`);
    return s3Client;
  } catch (err) {
    logger.error('Gagal inisialisasi Cloudflare R2 Client:', err.message);
    return null;
  }
}

/**
 * Mendapatkan Public URL untuk file di Cloudflare R2.
 *
 * @param {string} r2Key - Key object di R2 (misal: "outputs/job-123.png")
 * @returns {string} Public URL
 */
function getR2PublicUrl(r2Key) {
  if (!r2Key) return '';

  // Jika r2Key sudah merupakan full URL
  if (r2Key.startsWith('http://') || r2Key.startsWith('https://')) {
    return r2Key;
  }

  const cleanKey = r2Key.replace(/^\/+/, '');
  if (config.r2.publicDomain) {
    return `${config.r2.publicDomain}/${cleanKey}`;
  }

  // Fallback endpoint proxy
  return `/api/jobs/${path.basename(cleanKey, path.extname(cleanKey))}/image`;
}

/**
 * Mengunggah file dari disk lokal ke Cloudflare R2.
 *
 * @param {string} localFilePath - Path file lokal di server
 * @param {string} r2Key         - Key target di R2 (misal: "outputs/job-123.png")
 * @param {string} [contentType='image/png'] - MIME type
 * @returns {Promise<{ key: string, publicUrl: string }>}
 */
async function uploadToR2(localFilePath, r2Key, contentType = 'image/png') {
  const client = getS3Client();

  if (!client) {
    // Fallback: gunakan file lokal
    return {
      key: r2Key,
      publicUrl: `/api/jobs/${path.basename(r2Key, path.extname(r2Key))}/image`,
    };
  }

  const fileBuffer = fs.readFileSync(localFilePath);

  const command = new PutObjectCommand({
    Bucket: config.r2.bucketName,
    Key: r2Key,
    Body: fileBuffer,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  });

  await client.send(command);

  const publicUrl = getR2PublicUrl(r2Key);
  logger.info(`[Cloudflare R2] File berhasil diupload: ${r2Key} -> ${publicUrl}`);

  return {
    key: r2Key,
    publicUrl,
  };
}

/**
 * Menghapus file dari Cloudflare R2.
 *
 * @param {string} r2Key - Key object di R2
 * @returns {Promise<boolean>}
 */
async function deleteFromR2(r2Key) {
  const client = getS3Client();
  if (!client || !r2Key) return false;

  try {
    const cleanKey = r2Key.startsWith('http')
      ? r2Key.replace(config.r2.publicDomain, '').replace(/^\/+/, '')
      : r2Key;

    const command = new DeleteObjectCommand({
      Bucket: config.r2.bucketName,
      Key: cleanKey,
    });

    await client.send(command);
    logger.info(`[Cloudflare R2] File berhasil dihapus: ${cleanKey}`);
    return true;
  } catch (err) {
    logger.warn(`[Cloudflare R2] Gagal hapus file ${r2Key}:`, err.message);
    return false;
  }
}

/**
 * Mengecek apakah Cloudflare R2 aktif dan siap pakai.
 * @returns {boolean}
 */
function isR2Active() {
  return config.r2.isConfigured && Boolean(getS3Client());
}

module.exports = {
  uploadToR2,
  deleteFromR2,
  getR2PublicUrl,
  isR2Active,
};
