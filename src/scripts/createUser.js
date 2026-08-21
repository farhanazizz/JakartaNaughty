/**
 * ============================================================
 * src/scripts/createUser.js — CLI Helper untuk Buat User / Admin
 * ============================================================
 * Script praktis untuk membuat user baru langsung dari terminal.
 * Berguna saat pertama kali setup sistem sebelum ada admin di web.
 *
 * Penggunaan:
 *   node src/scripts/createUser.js <email> <password> [credits] [role]
 *
 * Contoh:
 *   node src/scripts/createUser.js user@gmail.com password123 50 user
 *   node src/scripts/createUser.js admin@gmail.com admin12345 100 admin
 * ============================================================
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const { initDb, getDb, closeDb } = require('../config/database');
const { hashPassword } = require('../utils/hash');
const { addCredit } = require('../services/creditService');

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log('\n📖 Penggunaan:');
    console.log('   node src/scripts/createUser.js <email> <password> [credits] [role]\n');
    console.log('Contoh:');
    console.log('   node src/scripts/createUser.js user1@test.com secret123 20 user\n');
    process.exit(1);
  }

  const email   = args[0].toLowerCase().trim();
  const password = args[1];
  const credits  = parseInt(args[2] || '0', 10);
  const role     = (args[3] || 'user').toLowerCase();

  await initDb();
  const db = getDb();

  // Cek apakah email sudah ada
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    console.error(`\n❌ Error: User dengan email "${email}" sudah terdaftar!`);
    closeDb();
    process.exit(1);
  }

  // Hash password
  const passwordHash = await hashPassword(password);
  const userId = uuidv4();
  const now = new Date().toISOString();

  // Insert user
  db.prepare(`
    INSERT INTO users (id, email, password_hash, role, credits, is_active, created_at)
    VALUES (?, ?, ?, ?, 0, 1, ?)
  `).run(userId, email, passwordHash, role, now);

  // Tambah kredit jika > 0
  if (credits > 0) {
    addCredit(userId, credits, 'Kredit awal pembuatan akun via CLI', 'system_cli');
  }

  const user = db.prepare('SELECT id, email, role, credits, is_active FROM users WHERE id = ?').get(userId);

  console.log('\n✅ User berhasil dibuat!');
  console.log('---------------------------------');
  console.log(`ID      : ${user.id}`);
  console.log(`Email   : ${user.email}`);
  console.log(`Role    : ${user.role}`);
  console.log(`Kredit  : ${user.credits}`);
  console.log(`Status  : ${user.is_active ? 'Aktif' : 'Nonaktif'}`);
  console.log('---------------------------------\n');

  closeDb();
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
