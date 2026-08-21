/**
 * ============================================================
 * src/utils/securityLogger.js — Security & Audit Log Helper
 * ============================================================
 * Mencatat setiap aktivitas keamanan, login attempt, IP address,
 * dan User-Agent string secara real-time ke tabel security_logs.
 * ============================================================
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../config/database');

/**
 * Mengambil IP asli client di balik proxy/Cloudflare Tunnel.
 */
function getClientIp(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.ip ||
    req.socket?.remoteAddress ||
    '127.0.0.1'
  );
}

/**
 * Mengambil User-Agent lengkap dari header request.
 */
function getUserAgent(req) {
  return req.headers['user-agent'] || 'Unknown User-Agent';
}

/**
 * Menyimpan log keamanan ke database.
 *
 * @param {import('express').Request} req
 * @param {Object} data
 * @param {string} data.username  - Username atau email
 * @param {string} data.event     - Nama event (LOGIN_SUCCESS, LOGIN_FAIL, dll)
 * @param {string} [data.status]  - 'SUCCESS' | 'WARNING' | 'DANGER' | 'INFO'
 * @param {string|Object} [data.detail] - Detail tambahan
 */
function logSecurityEvent(req, { username, event, status = 'INFO', detail = '' }) {
  try {
    const db = getDb();
    const id = uuidv4();
    const ip = getClientIp(req);
    const ua = getUserAgent(req);
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO security_logs (id, username, event, status, ip_address, user_agent, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      username || 'anonymous',
      event,
      status,
      ip,
      ua,
      typeof detail === 'string' ? detail : JSON.stringify(detail),
      now
    );
  } catch (err) {
    console.error('Security log write error:', err.message);
  }
}

module.exports = { getClientIp, getUserAgent, logSecurityEvent };
