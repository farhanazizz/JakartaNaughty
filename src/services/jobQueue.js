/**
 * ============================================================
 * src/services/jobQueue.js — Manajemen Antrian Job
 * ============================================================
 * Job queue berbasis database (SQLite) — tidak butuh Redis.
 * Cara kerja:
 *  1. User submit job → masuk ke tabel 'jobs' dengan status 'pending'
 *  2. Worker (loop setiap 5 detik) ambil job pending
 *  3. Worker pilih GPU terbaik via vastai.pickBestGpu()
 *  4. Worker submit ke ComfyUI, update status → 'processing'
 *  5. Worker poll ComfyUI setiap 3 detik sampai selesai
 *  6. Selesai → download output, update status → 'done'
 *  7. Gagal/timeout → update status → 'failed'
 * ============================================================
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../config/database');
const { submitJob, getJobStatus, downloadOutput } = require('./comfyui');
const { pickBestGpu } = require('./vastai');
const { config } = require('../config/env');
const { logger } = require('../utils/logger');

// -------------------------------------------------------
// Konstanta
// -------------------------------------------------------

/** Interval pengecekan queue (ms) */
const WORKER_INTERVAL_MS = 5000; // 5 detik

/** Interval polling status job di ComfyUI (ms) */
const POLL_INTERVAL_MS = 3000; // 3 detik

/** Timeout job dalam ms */
const JOB_TIMEOUT_MS = config.jobs.timeoutMinutes * 60 * 1000;

/** Set job ID yang sedang di-poll (mencegah double processing) */
const activeJobs = new Set();

// -------------------------------------------------------
// Fungsi Publik
// -------------------------------------------------------

/**
 * Menambahkan job baru ke antrian.
 * Kredit sudah dikurangi sebelum fungsi ini dipanggil.
 *
 * @param {string} userId     - ID user yang submit job
 * @param {Object} jobData    - Data job
 * @param {string} jobData.sourceImageName   - Nama file asli (untuk display)
 * @param {string} jobData.sourceImagePath   - Path file di server (uploads/)
 * @param {string} jobData.positivePrompt    - Prompt positif
 * @param {string} jobData.negativePrompt    - Prompt negatif
 * @param {number} [jobData.seed=-1]         - Seed (default: random)
 * @returns {{ jobId: string, queuePosition: number }}
 */
function enqueueJob(userId, jobData) {
  const db = getDb();

  // Cek apakah user sudah punya terlalu banyak job aktif
  const activeCount = db.prepare(`
    SELECT COUNT(*) as count FROM jobs
    WHERE user_id = ? AND status IN ('pending', 'processing')
  `).get(userId);

  if (activeCount.count >= config.jobs.maxConcurrentPerUser) {
    throw new Error(
      `Kamu sudah punya ${activeCount.count} job yang sedang berjalan. ` +
      `Maksimal ${config.jobs.maxConcurrentPerUser} job bersamaan.`
    );
  }

  // Buat job baru di database
  const jobId = uuidv4();
  const now = new Date().toISOString();
  const refBoost = jobData.refBoost ?? 4.2;

  db.prepare(`
    INSERT INTO jobs (
      id, user_id, status, source_image_name, source_image_path,
      positive_prompt, negative_prompt, seed, ref_boost, credits_used, created_at
    ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    jobId,
    userId,
    jobData.sourceImageName,
    jobData.sourceImagePath,
    jobData.positivePrompt,
    jobData.negativePrompt || '',
    jobData.seed ?? -1,
    refBoost,
    now
  );


  // Hitung posisi dalam antrian
  const position = db.prepare(`
    SELECT COUNT(*) as count FROM jobs
    WHERE status = 'pending' AND created_at <= ?
  `).get(now);

  logger.info(`Job baru: id=${jobId} user=${userId} posisi=${position.count}`);

  return { jobId, queuePosition: position.count };
}

/**
 * Mendapatkan info job berdasarkan ID.
 *
 * @param {string} jobId  - ID job
 * @param {string} userId - ID user (untuk validasi kepemilikan)
 * @returns {Object|null} Data job atau null
 */
function getJobById(jobId, userId = null) {
  const db = getDb();
  const query = userId
    ? 'SELECT * FROM jobs WHERE id = ? AND user_id = ?'
    : 'SELECT * FROM jobs WHERE id = ?';
  const params = userId ? [jobId, userId] : [jobId];
  return db.prepare(query).get(...params);
}

/**
 * Mendapatkan posisi job dalam antrian.
 * Hanya berlaku untuk job dengan status 'pending'.
 *
 * @param {string} jobId - ID job
 * @returns {number} Posisi antrian (1 = paling depan), 0 jika tidak pending
 */
function getQueuePosition(jobId) {
  const db = getDb();
  const job = db.prepare('SELECT created_at FROM jobs WHERE id = ?').get(jobId);
  if (!job) return 0;

  const result = db.prepare(`
    SELECT COUNT(*) as position FROM jobs
    WHERE status = 'pending' AND created_at <= ?
  `).get(job.created_at);

  return result.position;
}

// -------------------------------------------------------
// Fungsi Internal Worker
// -------------------------------------------------------

/**
 * Memproses satu job dari antrian.
 * Dipanggil oleh worker loop.
 *
 * @param {Object} job - Data job dari database
 */
async function processJob(job) {
  const db = getDb();

  // Tambahkan ke set activeJobs untuk mencegah double-processing
  activeJobs.add(job.id);

  logger.info(`Memproses job: id=${job.id} user=${job.user_id}`);

  try {
    // 1. Pilih GPU terbaik
    const gpu = await pickBestGpu();

    if (!gpu) {
      // Tidak ada GPU yang online — biarkan job tetap 'pending'
      logger.warn(`Job ${job.id}: tidak ada GPU tersedia, tunggu giliran berikutnya`);
      activeJobs.delete(job.id);
      return;
    }

    // 2. Update status ke 'processing' dan catat GPU yang dipakai
    db.prepare(`
      UPDATE jobs SET
        status = 'processing',
        gpu_instance_id = ?,
        gpu_instance_url = ?,
        started_at = ?
      WHERE id = ?
    `).run(gpu.id, gpu.url, new Date().toISOString(), job.id);

    // 3. Submit job ke ComfyUI — sertakan token auth dari gpu object & ref_boost
    const { promptId, seed: actualSeed } = await submitJob(gpu.url, {
      sourceImagePath: job.source_image_path,
      positivePrompt:  job.positive_prompt,
      negativePrompt:  job.negative_prompt,
      seed:            job.seed,
      refBoost:        job.ref_boost || 4.2,
      token:           gpu.token || '', // ← Sertakan jupyter_token Vast.ai
    });


    // 4. Simpan prompt_id dan seed aktual ke database
    db.prepare(`
      UPDATE jobs SET comfyui_prompt_id = ?, seed = ? WHERE id = ?
    `).run(promptId, actualSeed, job.id);

    logger.info(`Job ${job.id} berhasil disubmit ke ComfyUI: promptId=${promptId}`);

    // 5. Mulai polling status job (sertakan token untuk polling)
    await pollUntilDone(job.id, gpu.url, promptId, gpu.token || '');

  } catch (err) {
    // Jika ada error saat submit atau proses — refund kredit ke user
    logger.error(`Job ${job.id} gagal: ${err.message}`);

    db.prepare(`
      UPDATE jobs SET
        status = 'failed',
        error_message = ?,
        completed_at = ?
      WHERE id = ?
    `).run(err.message, new Date().toISOString(), job.id);

    // Kembalikan kredit yang sudah dipotong agar user tidak rugi
    try {
      const { addCredit } = require('../services/creditService');
      addCredit(job.user_id, job.credits_used || 1, 'Refund otomatis: generate gagal (' + err.message.substring(0, 60) + ')', null);
      logger.info(`Kredit ${job.credits_used || 1} dikembalikan ke user ${job.user_id} (job ${job.id} gagal)`);
    } catch (refundErr) {
      logger.error(`Gagal refund kredit untuk job ${job.id}: ${refundErr.message}`);
    }

  } finally {
    activeJobs.delete(job.id);
  }
}

/**
 * Poll status job di ComfyUI sampai selesai atau timeout.
 *
 * @param {string} jobId      - ID job di database kita
 * @param {string} comfyUrl   - URL ComfyUI instance
 * @param {string} promptId   - Prompt ID dari ComfyUI
 * @param {string} [token=''] - Token auth Vast.ai
 */
async function pollUntilDone(jobId, comfyUrl, promptId, token) {
  token = token || '';
  const db        = getDb();
  const startTime = Date.now();

  // Loop polling setiap POLL_INTERVAL_MS
  while (true) {
    // Cek timeout
    if (Date.now() - startTime > JOB_TIMEOUT_MS) {
      db.prepare(`
        UPDATE jobs SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?
      `).run('Timeout: job melebihi batas waktu', new Date().toISOString(), jobId);

      logger.warn(`Job ${jobId} timeout setelah ${config.jobs.timeoutMinutes} menit`);

      // Refund kredit karena timeout
      try {
        const job = db.prepare('SELECT user_id, credits_used FROM jobs WHERE id = ?').get(jobId);
        if (job) {
          const { addCredit } = require('../services/creditService');
          addCredit(job.user_id, job.credits_used || 1, 'Refund otomatis: generate timeout', null);
          logger.info(`Kredit dikembalikan ke user ${job.user_id} karena timeout job ${jobId}`);
        }
      } catch (refundErr) {
        logger.error(`Gagal refund kredit timeout job ${jobId}: ${refundErr.message}`);
      }

      return;
    }

    // Cek status di ComfyUI — sertakan token auth
    const { status, outputFiles, error } = await getJobStatus(comfyUrl, promptId, token);

    if (status === 'done' && outputFiles.length > 0) {
      // Job selesai! Download output
      try {
        const outputFilename = `${jobId}.png`;
        const outputPath = path.join(config.upload.outputDir, outputFilename);

        // Download dengan token auth
        await downloadOutput(comfyUrl, outputFiles[0], outputPath, token);

        // Update database: selesai
        db.prepare(`
          UPDATE jobs SET
            status = 'done',
            output_filename = ?,
            completed_at = ?
          WHERE id = ?
        `).run(outputFilename, new Date().toISOString(), jobId);

        logger.info(`Job ${jobId} SELESAI: output=${outputFilename}`);
        return;

      } catch (downloadErr) {
        const errMsg = `Gagal download output: ${downloadErr.message}`;
        db.prepare(`
          UPDATE jobs SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?
        `).run(errMsg, new Date().toISOString(), jobId);

        // Refund kredit karena download gagal
        try {
          const job = db.prepare('SELECT user_id, credits_used FROM jobs WHERE id = ?').get(jobId);
          if (job) {
            const { addCredit } = require('../services/creditService');
            addCredit(job.user_id, job.credits_used || 1, 'Refund otomatis: gagal download hasil generate', null);
            logger.info(`Kredit dikembalikan ke user ${job.user_id} karena download gagal job ${jobId}`);
          }
        } catch (refundErr) {
          logger.error(`Gagal refund kredit download-fail job ${jobId}: ${refundErr.message}`);
        }
        return;
      }
    }

    if (status === 'failed') {
      const errMsg = error || 'ComfyUI melaporkan error';
      db.prepare(`
        UPDATE jobs SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?
      `).run(errMsg, new Date().toISOString(), jobId);

      logger.error(`Job ${jobId} GAGAL di ComfyUI: ${errMsg}`);

      // Refund kredit karena ComfyUI error
      try {
        const job = db.prepare('SELECT user_id, credits_used FROM jobs WHERE id = ?').get(jobId);
        if (job) {
          const { addCredit } = require('../services/creditService');
          addCredit(job.user_id, job.credits_used || 1, 'Refund otomatis: ComfyUI error', null);
          logger.info(`Kredit dikembalikan ke user ${job.user_id} karena ComfyUI error job ${jobId}`);
        }
      } catch (refundErr) {
        logger.error(`Gagal refund kredit ComfyUI-error job ${jobId}: ${refundErr.message}`);
      }

      return;
    }

    // Masih pending/processing — tunggu sebentar sebelum poll lagi
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/**
 * Worker loop — dijalankan setiap WORKER_INTERVAL_MS.
 * Ambil job pending dan mulai proses.
 */
async function runWorkerCycle() {
  const db = getDb();

  // Ambil job pending yang belum diproses (tidak ada di activeJobs)
  const pendingJobs = db.prepare(`
    SELECT * FROM jobs
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT 5
  `).all();

  // Filter job yang belum ada di activeJobs
  const jobsToProcess = pendingJobs.filter((job) => !activeJobs.has(job.id));

  if (jobsToProcess.length === 0) return; // Tidak ada yang perlu diproses

  logger.debug(`Worker: ${jobsToProcess.length} job pending ditemukan`);

  // Proses job secara paralel (maksimal sesuai jumlah GPU yang tersedia)
  await Promise.all(jobsToProcess.map((job) => processJob(job)));
}

/**
 * Mulai job queue worker.
 * Dipanggil sekali saat server startup.
 * Worker berjalan terus sebagai background process.
 */
function startQueueWorker() {
  logger.info(`Job queue worker dimulai (interval: ${WORKER_INTERVAL_MS / 1000}s)`);

  // Jalankan worker pertama kali setelah 2 detik (beri waktu server siap)
  setTimeout(() => {
    // Kemudian jalankan setiap WORKER_INTERVAL_MS
    setInterval(async () => {
      try {
        await runWorkerCycle();
      } catch (err) {
        logger.error('Worker error:', err.message);
      }
    }, WORKER_INTERVAL_MS);
  }, 2000);
}

module.exports = {
  enqueueJob,
  getJobById,
  getQueuePosition,
  startQueueWorker,
};
