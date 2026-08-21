/**
 * ============================================================
 * src/middleware/fileUpload.js — Konfigurasi File Upload
 * ============================================================
 * Menggunakan Multer untuk menangani upload file gambar.
 * Fitur keamanan:
 *  - Validasi MIME type (bukan hanya extension)
 *  - Nama file dirandom (UUID) untuk mencegah path traversal
 *  - Batasan ukuran file dari env variable
 *  - Hanya terima JPEG dan PNG
 * ============================================================
 */

'use strict';

const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { config } = require('../config/env');

/**
 * Konfigurasi penyimpanan file Multer.
 * File disimpan di folder 'uploads/' dengan nama random.
 */
const storage = multer.diskStorage({
  /**
   * Tentukan folder tujuan upload.
   * Folder 'uploads/' harus sudah ada sebelum server jalan.
   */
  destination: (req, file, cb) => {
    cb(null, config.upload.uploadDir);
  },

  /**
   * Generate nama file yang aman dan unik.
   * Format: {uuid}.{ext_original}
   * Contoh: a1b2c3d4-xxxx.jpg
   *
   * Kita gunakan UUID agar:
   * 1. Nama file tidak bisa ditebak
   * 2. Tidak ada konflik nama
   * 3. Tidak ada path traversal attack
   */
  filename: (req, file, cb) => {
    // Ambil extension dari nama file asli (lowercase untuk konsistensi)
    const ext = path.extname(file.originalname).toLowerCase();
    const safeName = `${uuidv4()}${ext}`;
    cb(null, safeName);
  },
});

/**
 * Filter file — hanya terima JPEG dan PNG.
 * Validasi berdasarkan MIME type (lebih aman daripada cek extension saja).
 */
function fileFilter(req, file, cb) {
  const isAllowed = config.upload.allowedMimeTypes.includes(file.mimetype);

  if (isAllowed) {
    cb(null, true); // Terima file
  } else {
    // Tolak file dengan pesan error yang jelas
    cb(new Error(`Tipe file tidak didukung: ${file.mimetype}. Hanya JPEG dan PNG yang diterima.`), false);
  }
}

/**
 * Instance Multer yang sudah dikonfigurasi.
 * Siap dipakai sebagai middleware di route.
 */
const upload = multer({
  storage,
  fileFilter,
  limits: {
    // Konversi MB ke bytes untuk limit Multer
    fileSize: config.upload.maxSizeMb * 1024 * 1024,
    files: 1, // Hanya boleh upload 1 file sekaligus
  },
});

/**
 * Middleware untuk upload single file dengan field name 'source_image'.
 * Tambahkan error handling khusus untuk Multer.
 *
 * Cara pakai:
 *   router.post('/generate', uploadSingleImage, handler)
 */
function uploadSingleImage(req, res, next) {
  const handler = upload.single('source_image');

  handler(req, res, (err) => {
    if (!err) return next(); // Sukses

    // Handle error dari Multer
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          success: false,
          message: `Ukuran file terlalu besar. Maksimal ${config.upload.maxSizeMb}MB.`,
        });
      }
      return res.status(400).json({
        success: false,
        message: `Error upload: ${err.message}`,
      });
    }

    // Error dari fileFilter (tipe file tidak didukung)
    if (err) {
      return res.status(400).json({
        success: false,
        message: err.message,
      });
    }
  });
}

module.exports = { uploadSingleImage };
