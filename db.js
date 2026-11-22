require('dotenv').config();
const { Pool } = require('pg');

const config = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, max: 10 }
  : {
      host: process.env.PGHOST,
      port: +(process.env.PGPORT || 5432),
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE,
      max: 10
    };

const pool = new Pool(config);
pool.on('error', err => console.error('[pg] idle client error', err));

module.exports = { pool };