/**
 * ============================================================
 * src/config/passport.js — Google OAuth untuk Admin Login
 * ============================================================
 * Setup Passport.js dengan Google OAuth2 strategy.
 * HANYA untuk admin — cek email di ADMIN_EMAILS whitelist.
 * Email yang tidak ada di whitelist langsung ditolak.
 * ============================================================
 */

'use strict';

const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { config } = require('./env');
const { logger } = require('../utils/logger');

/**
 * Konfigurasi Google OAuth2 Strategy.
 * Dipanggil setelah user berhasil autentikasi di Google.
 *
 * @param {string}   accessToken  - Token Google (tidak kita simpan)
 * @param {string}   refreshToken - Refresh token Google (tidak kita simpan)
 * @param {Object}   profile      - Data profil dari Google
 * @param {Function} done         - Callback Passport
 */
if (config.google.clientId && config.google.clientSecret) {
  passport.use(new GoogleStrategy(
    {
      clientID:     config.google.clientId,
      clientSecret: config.google.clientSecret,
      callbackURL:  config.google.callbackUrl,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        // Ambil email dari profil Google
        const email = profile.emails?.[0]?.value?.toLowerCase();

        if (!email) {
          logger.warn('Google OAuth: profil tidak punya email');
          return done(null, false, { message: 'Tidak bisa mengambil email dari akun Google' });
        }

        // Cek apakah email ada di whitelist admin (dari .env ADMIN_EMAILS)
        if (!config.adminEmails.includes(email)) {
          logger.warn(`Login admin ditolak: ${email} bukan dalam whitelist admin`);
          return done(null, false, { message: 'Email tidak diotorisasi sebagai admin' });
        }

        logger.info(`Admin berhasil login via Google: ${email}`);

        // Return object admin — tidak disimpan ke DB karena admin via Google saja
        return done(null, {
          id:    'google_admin',  // ID virtual untuk admin Google
          email,
          role:  'admin',
          name:  profile.displayName || email,
        });

      } catch (err) {
        logger.error('Google OAuth error:', err);
        return done(err);
      }
    }
  ));
} else {
  logger.warn('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET belum diisi di .env — Google OAuth belum aktif.');
}

/**
 * Serialize user ke session (simpan data minimal)
 */
passport.serializeUser((user, done) => {
  done(null, user);
});

/**
 * Deserialize user dari session
 */
passport.deserializeUser((user, done) => {
  done(null, user);
});

module.exports = passport;
