/**
 * ============================================================
 * src/routes/admin/credits.js — Admin: Manajemen Kredit
 * ============================================================
 * Endpoints:
 *   POST /api/admin/credits/:userId/add    — Tambah kredit
 *   POST /api/admin/credits/:userId/deduct — Kurangi kredit
 *   GET  /api/admin/credits/:userId/history — History kredit
 * ============================================================
 */

'use strict';

const express = require('express');
const { addCredit, deductCredit, getCreditHistory } = require('../../services/creditService');
const { logAudit } = require('./users');
const { logger } = require('../../utils/logger');

const router = express.Router();

// ============================================================
// POST /api/admin/credits/:userId/add — Tambah kredit
// ============================================================
router.post('/:userId/add', (req, res) => {
  try {
    const { amount, reason } = req.body;

    // Validasi input
    if (!amount || parseInt(amount) <= 0) {
      return res.status(400).json({ success: false, message: 'Amount harus berupa angka positif.' });
    }
    if (!reason || reason.trim().length < 3) {
      return res.status(400).json({ success: false, message: 'Alasan (reason) wajib diisi.' });
    }

    const userId = req.params.userId;
    const intAmount = parseInt(amount);

    // Tambah kredit via credit service
    const result = addCredit(userId, intAmount, reason.trim(), req.user.id);

    if (!result.success) {
      return res.status(400).json({ success: false, message: result.message });
    }

    // Catat audit log
    logAudit(
      req.user.id,
      'ADD_CREDIT',
      userId,
      JSON.stringify({ amount: intAmount, reason: reason.trim(), newBalance: result.newBalance }),
      req.ip
    );

    logger.info(`Admin ${req.user.id} tambah ${intAmount} kredit ke user ${userId}`);

    return res.json({
      success: true,
      message: `Berhasil menambahkan ${intAmount} kredit.`,
      data: { newBalance: result.newBalance },
    });

  } catch (err) {
    logger.error('Add credit error:', err.message);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
});

// ============================================================
// POST /api/admin/credits/:userId/deduct — Kurangi kredit manual
// ============================================================
router.post('/:userId/deduct', (req, res) => {
  try {
    const { amount, reason } = req.body;

    if (!amount || parseInt(amount) <= 0) {
      return res.status(400).json({ success: false, message: 'Amount harus berupa angka positif.' });
    }
    if (!reason || reason.trim().length < 3) {
      return res.status(400).json({ success: false, message: 'Alasan wajib diisi.' });
    }

    const userId    = req.params.userId;
    const intAmount = parseInt(amount);

    const result = deductCredit(userId, intAmount, `[Admin] ${reason.trim()}`);

    if (!result.success) {
      return res.status(400).json({ success: false, message: result.message });
    }

    logAudit(
      req.user.id,
      'DEDUCT_CREDIT',
      userId,
      JSON.stringify({ amount: intAmount, reason: reason.trim(), newBalance: result.newBalance }),
      req.ip
    );

    logger.info(`Admin ${req.user.id} kurangi ${intAmount} kredit dari user ${userId}`);

    return res.json({
      success: true,
      message: `Berhasil mengurangi ${intAmount} kredit.`,
      data: { newBalance: result.newBalance },
    });

  } catch (err) {
    logger.error('Deduct credit error:', err.message);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
});

// ============================================================
// GET /api/admin/credits/:userId/history — History kredit
// ============================================================
router.get('/:userId/history', (req, res) => {
  const limit  = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;

  const history = getCreditHistory(req.params.userId, limit, offset);

  return res.json({ success: true, data: history });
});

module.exports = router;
