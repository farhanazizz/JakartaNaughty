/**
 * ============================================================
 * src/routes/generate.js — Route Submit Job Generate
 * ============================================================
 * Endpoint: POST /api/generate
 * 
 * Alur lengkap:
 *  1. Validasi user sudah login (authMiddleware)
 *  2. Rate limit (generateLimiter)
 *  3. Terima file upload (uploadSingleImage)
 *  4. Validasi input (prompt, file)
 *  5. Cek kredit user
 *  6. Potong kredit (atomic)
 *  7. Masukkan job ke antrian
 *  8. Return job ID dan posisi antrian
 * ============================================================
 */

'use strict';

const express = require('express');
const fs = require('fs');
const { getDb } = require('../config/database');
const { deductCredit, addCredit } = require('../services/creditService');
const { enqueueJob } = require('../services/jobQueue');
const { uploadSingleImage } = require('../middleware/fileUpload');
const { generateLimiter } = require('../middleware/rateLimiter');
const authMiddleware = require('../middleware/auth');
const { logger } = require('../utils/logger');

const router = express.Router();

/**
 * POST /api/generate — Submit job generate gambar baru.
 *
 * Body (multipart/form-data):
 *   - source_image:    file JPEG/PNG (wajib)
 *   - positive_prompt: string (wajib, min 10 karakter)
 *   - negative_prompt: string (opsional)
 *   - seed:            number (opsional, default: -1 = random)
 */
router.post(
  '/',
  authMiddleware,       // 1. Cek login
  generateLimiter,      // 2. Rate limit
  uploadSingleImage,    // 3. Handle file upload
  async (req, res) => {
    const userId = req.user.id;

    try {
      // -------------------------------------------------------
      // Validasi: file gambar harus ada
      // -------------------------------------------------------
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: 'Gambar source wajib diupload.',
        });
      }

      // -------------------------------------------------------
      // Validasi: positive prompt wajib dan cukup panjang
      // -------------------------------------------------------
      const positivePrompt = (req.body.positive_prompt || '').trim();
      if (!positivePrompt || positivePrompt.length < 10) {
        // Hapus file yang sudah diupload karena validasi gagal
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({
          success: false,
          message: 'Positive prompt wajib diisi dan minimal 10 karakter.',
        });
      }

      const negativePrompt = (req.body.negative_prompt || '').trim();
      const seed = parseInt(req.body.seed) || -1; // -1 = random

      // -------------------------------------------------------
      // Cek saldo kredit user
      // -------------------------------------------------------
      const db = getDb();
      const user = db.prepare('SELECT credits FROM users WHERE id = ? AND is_active = 1').get(userId);

      if (!user) {
        fs.unlink(req.file.path, () => {});
        return res.status(403).json({ success: false, message: 'User tidak ditemukan.' });
      }

      if (user.credits < 1) {
        fs.unlink(req.file.path, () => {});
        return res.status(403).json({
          success: false,
          message: 'Kredit kamu tidak cukup. Hubungi admin untuk mengisi kredit.',
        });
      }

      // -------------------------------------------------------
      // Potong kredit SEBELUM enqueue (atomic)
      // Jika enqueue gagal, kredit di-refund
      // -------------------------------------------------------
      const deductResult = deductCredit(userId, 1, 'Generate image');

      if (!deductResult.success) {
        fs.unlink(req.file.path, () => {});
        return res.status(403).json({
          success: false,
          message: deductResult.message || 'Gagal memotong kredit.',
        });
      }

      // -------------------------------------------------------
      // Masukkan job ke antrian
      // -------------------------------------------------------
      let enqueueResult;
      try {
        enqueueResult = enqueueJob(userId, {
          sourceImageName: req.file.originalname,
          sourceImagePath: req.file.path,
          positivePrompt,
          negativePrompt,
          seed,
        });
      } catch (enqueueErr) {
        // Enqueue gagal — refund kredit agar user tidak rugi
        logger.error(`Enqueue gagal untuk user ${userId}, refund kredit: ${enqueueErr.message}`);
        addCredit(userId, 1, 'Refund: gagal masuk antrian', null);

        // Hapus file upload yang tidak jadi dipakai
        fs.unlink(req.file.path, () => {});

        return res.status(500).json({
          success: false,
          message: enqueueErr.message || 'Gagal memasukkan job ke antrian.',
        });
      }

      logger.info(`Generate berhasil: user=${userId} jobId=${enqueueResult.jobId}`);

      return res.json({
        success: true,
        data: {
          jobId:         enqueueResult.jobId,
          queuePosition: enqueueResult.queuePosition,
          message:       `Job berhasil dimasukkan ke antrian. Posisi: ${enqueueResult.queuePosition}`,
        },
      });

    } catch (err) {
      logger.error('Generate route error:', err.message);

      // Cleanup file jika ada error tidak terduga
      if (req.file) fs.unlink(req.file.path, () => {});

      return res.status(500).json({
        success: false,
        message: 'Terjadi kesalahan server.',
      });
    }
  }
);

module.exports = router;
