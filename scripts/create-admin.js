'use strict';
// Creates an admin user. Run once after first deploy.
// Usage: node scripts/create-admin.js <username> <email> <password>
const { openSql } = require('../repo/sql');
const { hashPassword } = require('../auth');

const [,, username, email, password] = process.argv;
if (!username || !email || !password) {
  console.error('Uso: node scripts/create-admin.js <username> <email> <password>');
  process.exit(1);
}

(async () => {
  const db = openSql();
  try {
    const hash = hashPassword(password);
    const row = await db.get(
      "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, 'admin') RETURNING id, username, email, role",
      [username, email, hash]
    );
    console.log(`✓ Admin creado: id=${row.id} username=${row.username}`);
  } catch (e) {
    if (e.message?.includes('unique') || e.message?.includes('UNIQUE') || e.code === '23505') {
      console.error('✗ Ya existe un usuario con ese nombre o email.');
    } else {
      console.error('✗ Error:', e.message);
    }
    process.exit(1);
  }
  process.exit(0);
})();
