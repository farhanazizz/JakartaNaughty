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
const { pickBestGpu, decrementInFlight } = require('./vastai');
const { uploadToR2, isR2Active, deleteFromR2 } = require('./r2Storage');
const { config } = require('../config/env');
const { logger } = require('../utils/logger');


// -------------------------------------------------------
// Konstanta
// -------------------------------------------------------

/** Interval pengecekan queue (ms) */
const WORKER_INTERVAL_MS = 3000; // 3 detik (lebih responsif)

/** Interval polling status job di ComfyUI (ms) */
const POLL_INTERVAL_MS = 2500; // 2.5 detik

/** Timeout job dalam ms */
const JOB_TIMEOUT_MS = config.jobs.timeoutMinutes * 60 * 1000;

/** Maksimal percobaan pengalihan ke GPU lain jika terjadi gangguan/disconnect */
const MAX_FAILOVER_RETRIES = 2;

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
  const resolution = String(jobData.resolution || '1mp').toLowerCase() === '2mp' ? '2mp' : '1mp';
  const creditsUsed = parseInt(jobData.creditsUsed) || (resolution === '2mp' ? 2 : 1);

  db.prepare(`
    INSERT INTO jobs (
      id, user_id, status, source_image_name, source_image_path,
      positive_prompt, negative_prompt, seed, ref_boost, resolution, credits_used, created_at
    ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    jobId,
    userId,
    jobData.sourceImageName,
    jobData.sourceImagePath,
    jobData.positivePrompt,
    jobData.negativePrompt || '',
    jobData.seed ?? -1,
    refBoost,
    resolution,
    creditsUsed,
    now
  );



  // Hitung posisi dalam antrian
  const position = db.prepare(`
    SELECT COUNT(*) as count FROM jobs
    WHERE status = 'pending' AND created_at <= ?
  `).get(now);

  logger.info(`Job baru: id=${jobId} user=${userId} posisi=${position.count}`);

  // Pemicu instan: langsung jalankan worker dalam hitungan milidetik tanpa menunggu timer
  triggerQueueWorker();

  return {
    jobId,
    queuePosition: position.count,
  };
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
 * Memproses satu job dari antrian dengan dukungan Seamless Multi-GPU Auto-Failover.
 * Jika GPU yang sedang memproses mengalami gangguan (putus jaringan/error),
 * job akan otomatis dialihkan ke GPU lain yang sehat tanpa user perlu upload ulang.
 *
 * @param {Object} job - Data job dari database
 */
async function processJob(job) {
  const db = getDb();
  activeJobs.add(job.id);
  logger.info(`Memulai pemrosesan job: id=${job.id} user=${job.user_id}`);

  const triedGpuIds = [];
  let isSuccess = false;
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_FAILOVER_RETRIES; attempt++) {
    let currentGpu = null;

    try {
      // 1. Pilih GPU terbaik (secara otomatis menghindari GPU yang sudah dicoba dan gagal)
      currentGpu = await pickBestGpu(triedGpuIds);

      if (!currentGpu) {
        if (attempt === 0) {
          logger.warn(`Job ${job.id}: tidak ada GPU tersedia saat ini, tetap pending`);
          activeJobs.delete(job.id);
          return;
        } else {
          logger.warn(`Job ${job.id}: tidak ada GPU cadangan lain untuk failover attempt ${attempt + 1}`);
          throw new Error('Tidak ada GPU aktif lain yang tersedia untuk pengalihan');
        }
      }

      const isFailover = attempt > 0;
      if (isFailover) {
        logger.info(`🔄 [Failover Auto-Retry] Mengalihkan job ${job.id} ke GPU #${currentGpu.id} (${currentGpu.gpuName}) - Percobaan ke-${attempt + 1}`);
      }

      // 2. Update status ke 'processing' dan catat GPU yang sedang mengerjakan
      db.prepare(`
        UPDATE jobs SET
          status = 'processing',
          gpu_instance_id = ?,
          gpu_instance_url = ?,
          error_message = ?,
          started_at = COALESCE(started_at, ?)
        WHERE id = ?
      `).run(
        currentGpu.id,
        currentGpu.url,
        isFailover ? `Mengalihkan proses ke GPU cadangan (#${currentGpu.id})...` : null,
        new Date().toISOString(),
        job.id
      );

      // 3. Submit job ke ComfyUI pada GPU terpilih
      const { promptId, seed: actualSeed } = await submitJob(currentGpu.url, {
        sourceImagePath: job.source_image_path,
        positivePrompt:  job.positive_prompt,
        negativePrompt:  job.negative_prompt,
        seed:            job.seed,
        refBoost:        job.ref_boost || 4.2,
        resolution:      job.resolution || '1mp',
        token:           currentGpu.token || '',
      });


      // 4. Simpan prompt_id dan seed aktual
      db.prepare(`
        UPDATE jobs SET comfyui_prompt_id = ?, seed = ? WHERE id = ?
      `).run(promptId, actualSeed, job.id);

      logger.info(`Job ${job.id} berhasil disubmit ke GPU #${currentGpu.id}: promptId=${promptId}`);

      // 5. Polling status hingga selesai
      await pollUntilDone(job.id, currentGpu.url, promptId, currentGpu.token || '');

      // Jika berhasil sampai sini tanpa error, tandai sukses dan keluar dari loop retry
      isSuccess = true;
      break;

    } catch (err) {
      lastError = err;
      logger.warn(`⚠️ Job ${job.id} mengalami kendala di GPU #${currentGpu ? currentGpu.id : 'unknown'} (percobaan ${attempt + 1}/${MAX_FAILOVER_RETRIES + 1}): ${err.message}`);

      if (currentGpu) {
        triedGpuIds.push(currentGpu.id);
      }

      if (attempt < MAX_FAILOVER_RETRIES) {
        logger.info(`🔄 Mempersiapkan pengalihan otomatis (auto-failover) job ${job.id} ke GPU alternatif...`);
        // Jeda 1.5 detik sebelum mencoba GPU berikutnya
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    } finally {
      if (currentGpu) {
        decrementInFlight(currentGpu.id);
      }
    }
  }

  activeJobs.delete(job.id);

  // Jika seluruh percobaan failover habis dan tetap gagal, barulah tandai failed dan refund kredit
  if (!isSuccess) {
    const finalErrMsg = lastError ? lastError.message : 'Gagal memproses gambar setelah beberapa kali pengalihan GPU';
    logger.error(`❌ Job ${job.id} GAGAL TOTAL setelah failover: ${finalErrMsg}`);

    db.prepare(`
      UPDATE jobs SET
        status = 'failed',
        error_message = ?,
        completed_at = ?
      WHERE id = ?
    `).run(finalErrMsg, new Date().toISOString(), job.id);

    try {
      const { addCredit } = require('./creditService');
      addCredit(job.user_id, job.credits_used || 1, 'Refund otomatis: generate gagal (' + finalErrMsg.substring(0, 60) + ')', null);
      logger.info(`Kredit ${job.credits_used || 1} dikembalikan ke user ${job.user_id} (job ${job.id} gagal total)`);
    } catch (refundErr) {
      logger.error(`Gagal refund kredit untuk job ${job.id}: ${refundErr.message}`);
    }
  }
}

/**
 * Poll status job di ComfyUI sampai selesai atau error.
 * Melempar error jika terjadi gangguan agar bisa ditangkap oleh mekanisme Auto-Failover.
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
      throw new Error(`Timeout: proses melebihi batas waktu ${config.jobs.timeoutMinutes} menit`);
    }

    // Cek status di ComfyUI — sertakan token auth
    const { status, outputFiles, error } = await getJobStatus(comfyUrl, promptId, token);

    if (status === 'done' && outputFiles.length > 0) {
      // Job selesai! Download output ke disk lokal sementara
      const outputFilename = `${jobId}.png`;
      const outputPath = path.join(config.upload.outputDir, outputFilename);

      await downloadOutput(comfyUrl, outputFiles[0], outputPath, token);

      let finalOutputRef = outputFilename;

      // Unggah ke Cloudflare R2 (S3-compatible CDN) jika aktif
      if (isR2Active()) {
        try {
          const r2Key = `outputs/${jobId}.png`;
          const r2Result = await uploadToR2(outputPath, r2Key, 'image/png');
          finalOutputRef = r2Result.publicUrl;

          // Hapus file lokal di VPS agar SSD server Coolify selalu bersih 0 MB
          try {
            if (fs.existsSync(outputPath)) {
              fs.unlinkSync(outputPath);
              logger.debug(`File lokal sementara dibersihkan: ${outputPath}`);
            }
          } catch (_) {}
        } catch (r2Err) {
          logger.warn(`Gagal upload ke Cloudflare R2 (${r2Err.message}), fallback ke file lokal.`);
        }
      }

      // Update database: selesai dengan sukses
      db.prepare(`
        UPDATE jobs SET
          status = 'done',
          output_filename = ?,
          error_message = NULL,
          completed_at = ?
        WHERE id = ?
      `).run(finalOutputRef, new Date().toISOString(), jobId);

      logger.info(`🎉 Job ${jobId} SELESAI DENGAN SUKSES: output=${finalOutputRef}`);
      return true;
    }


    if (status === 'failed') {
      throw new Error(error || 'ComfyUI melaporkan error pada rendering node');
    }

    // Masih pending/processing — tunggu sebentar sebelum poll lagi
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/**
 * Memanggil cycle worker seketika (tanpa menunggu timer interval)
 */
function triggerQueueWorker() {
  setImmediate(() => {
    runWorkerCycle().catch((err) => {
      logger.error('Triggered worker cycle error:', err.message);
    });
  });
}

/**
 * Worker loop — dijalankan secara instan (event-driven) dan berkala (heartbeat).
 * Mengambil job pending dan langsung mengalokasikannya ke GPU secara seimbang.
 */
async function runWorkerCycle() {
  const db = getDb();

  // Ambil job pending yang belum diproses (tidak ada di activeJobs)
  const pendingJobs = db.prepare(`
    SELECT * FROM jobs
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT 10
  `).all();

  // Filter job yang belum ada di activeJobs
  const jobsToProcess = pendingJobs.filter((job) => !activeJobs.has(job.id));

  if (jobsToProcess.length === 0) return;

  logger.debug(`Worker: ${jobsToProcess.length} job pending akan dialokasikan ke GPU`);

  // Proses setiap job secara berurutan agar reservasi in-flight GPU terjadi secara atomik dan adil,
  // tanpa memblokir worker loop (proses render berjalan di background masing-masing)
  for (const job of jobsToProcess) {
    if (activeJobs.has(job.id)) continue;
    processJob(job).catch((err) => {
      logger.error(`Unhandled error di processJob ${job.id}:`, err.message);
    });
  }
}

/**
 * Membersihkan file job yang berumur lebih dari 3 hari (72 jam)
 * sesuai dengan kebijakan retensi penyimpanan sementara (Cloudflare R2 & Lokal).
 */
async function cleanExpiredJobs() {
  try {
    const db = getDb();
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    const expiredJobs = db.prepare(`
      SELECT id, output_filename FROM jobs
      WHERE created_at < ? AND status = 'done'
    `).all(threeDaysAgo);

    if (expiredJobs.length === 0) return;

    logger.info(`[Retention Sweeper] Ditemukan ${expiredJobs.length} job kadaluarsa (>3 hari). Membersihkan storage...`);

    for (const job of expiredJobs) {
      if (job.output_filename) {
        if (job.output_filename.startsWith('http')) {
          const key = job.output_filename.replace(config.r2.publicDomain, '').replace(/^\/+/, '');
          await deleteFromR2(key);
        } else {
          const localPath = path.join(config.upload.outputDir, job.output_filename);
          try {
            if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
          } catch (_) {}
        }
      }

      // Tandai status sebagai expired di database
      db.prepare(`
        UPDATE jobs SET status = 'expired', output_filename = NULL WHERE id = ?
      `).run(job.id);
    }

    logger.info(`[Retention Sweeper] Selesai membersihkan ${expiredJobs.length} job kadaluarsa.`);
  } catch (err) {
    logger.error('[Retention Sweeper] Gagal membersihkan job kadaluarsa:', err.message);
  }
}

/**
 * Mulai job queue worker & retention cleanup scheduler.
 * Dipanggil sekali saat server startup.
 */
function startQueueWorker() {
  logger.info(`Job queue worker dimulai (interval watchdog: ${WORKER_INTERVAL_MS / 1000}s)`);

  // Jalankan worker pertama kali setelah 2 detik (beri waktu server siap)
  setTimeout(() => {
    // Watchdog interval untuk memastikan tidak ada job yang tertinggal
    setInterval(async () => {
      try {
        await runWorkerCycle();
      } catch (err) {
        logger.error('Worker error:', err.message);
      }
    }, WORKER_INTERVAL_MS);

    // Jalankan pembersihan retensi 3 hari setiap 1 jam sekali (3600000 ms)
    setInterval(cleanExpiredJobs, 60 * 60 * 1000);
    // Jalankan sekali saat startup
    cleanExpiredJobs().catch((err) => logger.warn('Initial cleanup error:', err.message));
  }, 2000);
}

module.exports = {
  enqueueJob,
  getJobById,
  getQueuePosition,
  startQueueWorker,
  triggerQueueWorker,
  cleanExpiredJobs,
};


