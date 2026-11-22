require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');

function describe(err) {
  if (!err) return 'Unknown error';
  const parts = [];
  if (err.code) parts.push(`code=${err.code}`);
  if (err.message) parts.push(`message=${err.message}`);
  if (err.detail) parts.push(`detail=${err.detail}`);
  if (err.hint) parts.push(`hint=${err.hint}`);
  return parts.join(' | ') || String(err);
}

(async () => {
  const drop = process.argv.includes('--drop');

  console.log('→ Connecting to PostgreSQL…');
  try {
    const probe = await pool.query('SELECT version() AS v');
    console.log('  ✓ Connected:', probe.rows[0].v.split(',')[0]);
  } catch (e) {
    console.error('\n❌ Cannot connect to PostgreSQL');
    console.error('   ' + describe(e));
    await pool.end();
    process.exit(1);
  }

  try {
    if (drop) {
      console.log('→ Dropping existing tables…');
      await pool.query(`
        DROP VIEW IF EXISTS v_reports_full CASCADE;
        DROP TABLE IF EXISTS settings, notifications, email_logs, advisories,
                             task_proofs, tasks, report_updates, photo_checks,
                             report_photos, reports, cases, boundaries,
                             appointments, categories, services, users CASCADE;
        DROP FUNCTION IF EXISTS set_updated_at CASCADE;
        DROP FUNCTION IF EXISTS generate_reference(TEXT) CASCADE;
      `);
      console.log('  ✓ Dropped');
    }

    const tablesExist = await pool.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'users'
      ) AS exists
    `);

    if (!tablesExist.rows[0].exists) {
      console.log('→ Fresh database — applying schema.sql…');
      const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
      await pool.query(schema);
      console.log('  ✓ Schema applied');
    } else {
      console.log('→ Existing schema detected — skipping schema.sql (use --drop to reset)');
    }

    console.log('→ Applying incremental patches…');

    await pool.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    `);
    console.log('  ✓ users.last_active_at');

    await pool.query(`
      ALTER TABLE services
        ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
      ALTER TABLE services DROP CONSTRAINT IF EXISTS services_name_key;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_services_global_name
        ON services(name) WHERE created_by IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_services_user_name
        ON services(name, created_by) WHERE created_by IS NOT NULL;
    `);
    console.log('  ✓ services (custom services + unique indexes)');

    await pool.query(`
      ALTER TABLE categories
        ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS is_active  BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_name_key;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_global_name
        ON categories(name) WHERE created_by IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_user_name
        ON categories(name, created_by) WHERE created_by IS NOT NULL;
    `);
    console.log('  ✓ categories (custom categories + unique indexes)');

    console.log('\n✅ Migration complete.');
  } catch (e) {
    console.error('\n❌ Migration failed');
    console.error('   ' + describe(e));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();