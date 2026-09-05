/**
 * ============================================================
 * src/server.js — Entry Point Utama Aplikasi
 * ============================================================
 * File ini adalah titik awal yang dijalankan saat `node src/server.js`.
 *
 * Urutan startup:
 *  1. Validasi environment variables
 *  2. Inisialisasi database + buat tabel
 *  3. Setup Express + semua middleware
 *  4. Register semua routes API
 *  5. Serve static files (frontend HTML)
 *  6. Error handler global
 *  7. Start HTTP server
 *  8. Jalankan background workers (job queue + GPU refresh)
 * ============================================================
 */

'use strict';

const express      = require('express');
const cookieParser = require('cookie-parser');
const session      = require('express-session');
const helmet       = require('helmet');
const cors         = require('cors');
const morgan       = require('morgan');
const path         = require('path');
const fs           = require('fs');

// Konfigurasi & utilities
const { validateEnv, config }     = require('./config/env');
const { initDb, getDb, closeDb } = require('./config/database');
const passport                    = require('./config/passport');
const { logger }                  = require('./utils/logger');

// Services
const { startQueueWorker } = require('./services/jobQueue');
const { refreshGpuPool }   = require('./services/vastai');

// Middleware
const { apiLimiter } = require('./middleware/rateLimiter');

// Routes
const authRoutes     = require('./routes/auth');
const generateRoutes = require('./routes/generate');
const generateVideoRoutes = require('./routes/generateVideo');
const videoGateRoutes = require('./routes/videoGate');
const { hasValidVideoGate } = require('./middleware/videoGate');
const jobsRoutes     = require('./routes/jobs');
const userRoutes     = require('./routes/user');
const adminRoutes    = require('./routes/admin/index');

// ============================================================
// LANGKAH 1: Validasi environment variables
// ============================================================
validateEnv();

// ============================================================
// LANGKAH 2: Setup Express
// ============================================================
const app = express();

// Set trust proxy agar Express mengenali header Cloudflare (CF-Connecting-IP, X-Forwarded-For) & HTTPS
app.set('trust proxy', 1);

// --- Middleware Keamanan ---

// Helmet: set security headers (XSS protection, HSTS, dll)
// Konfigurasi CSP khusus agar Tailwind CDN dan event handlers berfungsi
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.tailwindcss.com", "https://fonts.googleapis.com", "https://static.cloudflareinsights.com"],
      scriptSrcElem: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.tailwindcss.com", "https://fonts.googleapis.com", "https://static.cloudflareinsights.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:      ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://fonts.gstatic.com"],
      styleSrcElem:  ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://fonts.gstatic.com"],
      fontSrc:       ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc:        ["'self'", "data:", "blob:", "https:"],
      connectSrc:    ["'self'", "https:"],
    },
  },
}));

// CORS: izinkan request standard dari frontend/tunnel
app.use(cors());


// --- Middleware Logging ---
// Morgan format 'combined' mencatat semua request HTTP
app.use(morgan('combined', {
  stream: {
    write: (message) => logger.info(message.trim()),
  },
}));

// --- Middleware Parsing ---
app.use(express.json({ limit: '1mb' }));            // Parse JSON body
app.use(express.urlencoded({ extended: true }));     // Parse form data
app.use(cookieParser());                             // Parse cookies

// --- Session (dibutuhkan oleh Passport untuk OAuth) ---
app.use(session({
  secret:            config.session.secret,
  resave:            false,
  saveUninitialized: false,
  cookie: {
    secure:   config.isProduction, // Hanya HTTPS di production
    httpOnly: true,
    maxAge:   10 * 60 * 1000,      // 10 menit (session pendek, hanya untuk OAuth flow)
  },
}));

// --- Passport (Google OAuth) ---
app.use(passport.initialize());
app.use(passport.session());

// --- Rate Limiter Global untuk semua /api/* ---
app.use('/api', apiLimiter);

// ============================================================
// LANGKAH 4: Register Routes API
// ============================================================

// Auth routes — login, logout, refresh, OAuth
app.use('/api/auth', authRoutes);

// OAuth callback URL menggunakan /auth (tanpa /api) sesuai Google console
app.use('/auth', authRoutes);

// User routes — generate, jobs, dashboard
app.use('/api/generate', generateRoutes);
app.use('/api/video', generateVideoRoutes);
app.use('/api/generate-video', generateVideoRoutes); // back-compat
app.use('/api/video-gate', videoGateRoutes);
app.use('/api/jobs',     jobsRoutes);
app.use('/api/user',     userRoutes);

// --- Admin Stealth Shield (Anti-Scanning Fake 404) ---
const { adminShield } = require('./middleware/adminShield');
app.use('/admin', adminShield);
app.use('/api/admin', adminShield);

// Admin routes — dilindungi oleh authMiddleware + adminAuthMiddleware
app.use('/api/admin', adminRoutes);

// Health check endpoint untuk Traefik & Coolify
app.get('/health', (req, res) => res.status(200).json({ status: 'healthy', uptime: process.uptime() }));

// Root redirect
app.get('/', (req, res) => res.redirect('/login.html'));
app.get('/favicon.ico', (req, res) => res.status(204).end());


// AI Video HTML gate — password cookie required (serves unlock page otherwise)
app.get('/generate-video.html', (req, res) => {
  const publicDir = path.join(__dirname, '..', 'public');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (!hasValidVideoGate(req)) {
    return res.sendFile(path.join(publicDir, 'video-gate.html'));
  }
  return res.sendFile(path.join(publicDir, 'generate-video.html'));
});

// Serve folder public/ sebagai static files
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders(res, filePath) {
    if (String(filePath).toLowerCase().endsWith('.html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
    }
  },
}));

// Fallback: request ke /admin/* yang tidak ada → serve 404
// (Jangan redirect ke index.html karena ini bukan SPA)

// ============================================================
// LANGKAH 6: Error Handler Global
// ============================================================
// HARUS punya 4 parameter (err, req, res, next) untuk dikenali Express sebagai error handler
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  logger.error(`Unhandled error [${req.method} ${req.path}]:`, err.message);

  const status = err.status || err.statusCode || 500;

  return res.status(status).json({
    success: false,
    // Di production, jangan tampilkan detail error ke client (keamanan)
    message: config.isProduction
      ? 'Terjadi kesalahan pada server.'
      : err.message || 'Internal Server Error',
  });
});

// ============================================================
// LANGKAH 7: Pastikan folder yang dibutuhkan ada
// ============================================================
const requiredDirs = [
  config.upload.uploadDir,   // uploads/
  config.upload.outputDir,   // outputs/
];

requiredDirs.forEach((dir) => {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      logger.info(`Folder dibuat: ${dir}/`);
    }
  } catch (dirErr) {
    logger.warn(`Peringatan: Gagal membuat folder ${dir}: ${dirErr.message}`);
  }
});


/**
 * Memastikan akun admin default otomatis tersedia saat server pertama kali dijalankan.
 * Password diambil dari env ADMIN_PASSWORD atau default 'admin12345'.
 */
async function ensureDefaultAdmin() {
  const db = getDb();
  const adminUsers = ['admin', 'admin@jakarta.com'];
  const adminPass  = process.env.ADMIN_PASSWORD || 'admin12345';
  const { v4: uuidv4 }   = require('uuid');
  const { hashPassword } = require('./utils/hash');
  const { addCredit }    = require('./services/creditService');
  const passwordHash = await hashPassword(adminPass);
  const now = new Date().toISOString();

  for (const u of adminUsers) {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(u);
    if (!existing) {
      const userId = uuidv4();
      db.prepare(`
        INSERT INTO users (id, email, password_hash, role, credits, is_active, created_at)
        VALUES (?, ?, ?, 'admin', 0, 1, ?)
      `).run(userId, u, passwordHash, now);

      addCredit(userId, 1000, 'Saldo Awal Administrator', 'system_bootstrap');
      logger.info(`✨ Akun Admin otomatis dibuat: ${u} (password: ${adminPass})`);
    }
  }
}

// ============================================================
// LANGKAH 7: Inisialisasi Database & Start Server
// ============================================================
let server = null;

async function startServer() {
  try {
    // Inisialisasi database SQLite WASM & tabel
    await initDb();

    // Pastikan akun admin tersedia
    await ensureDefaultAdmin();

    const PORT = config.port;
    server = app.listen(PORT, () => {
      logger.info(`🚀 Server berjalan di http://localhost:${PORT}`);


      logger.info(`   Mode: ${config.nodeEnv}`);
      logger.info(`   Admin emails: ${config.adminEmails.join(', ') || '(tidak dikonfigurasi)'}`);

      // Background workers
      startQueueWorker();

      setInterval(() => {
        refreshGpuPool().catch((err) => logger.warn('GPU refresh gagal:', err.message));
      }, config.vastai.cacheTtlSeconds * 1000);

      refreshGpuPool().catch((err) => logger.warn('Initial GPU refresh gagal:', err.message));
    });
  } catch (err) {
    logger.error('Gagal memulai server:', err);
    process.exit(1);
  }
}

startServer();

// ============================================================
// Graceful Shutdown
// Tangkap sinyal SIGTERM (dari Docker/systemd/Coolify) dan
// SIGINT (Ctrl+C) untuk tutup server dengan bersih
// ============================================================
function gracefulShutdown(signal) {
  logger.info(`Menerima sinyal ${signal} — memulai graceful shutdown...`);

  server.close(() => {
    logger.info('HTTP server ditutup');
    closeDb();
    logger.info('Database ditutup. Bye! 👋');
    process.exit(0);
  });

  // Force exit jika shutdown terlalu lama (10 detik)
  setTimeout(() => {
    logger.error('Graceful shutdown timeout — force exit');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions — log dan lanjut (jangan crash server)
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
});

module.exports = app; // Export untuk testing
