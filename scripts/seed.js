require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'seed.sql'), 'utf8');
  try {
    await pool.query(sql);
    const { rows } = await pool.query('SELECT COUNT(*) FROM users');
    console.log('Seed applied. Users:', rows[0].count);
  } catch (e) {
    console.error('Seed failed:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();