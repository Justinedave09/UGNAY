require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { pool } = require('./db');
const { screenPhoto } = require('./ai');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret';
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '.jpg').slice(0, 6);
      cb(null, crypto.randomBytes(12).toString('hex') + ext);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 }
});

function sign(user) {
  return jwt.sign(
    { id: user.id, role: user.role, email: user.email },
    JWT_SECRET, { expiresIn: '7d' }
  );
}

function auth(requiredRoles = null) {
  return async (req, res, next) => {
    const hdr = req.headers.authorization || '';
    const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const { rows } = await pool.query(
        'SELECT id, email, name, role, last_active_at FROM users WHERE id = $1', [payload.id]);
      if (!rows[0]) return res.status(401).json({ error: 'User no longer exists' });
      if (requiredRoles && !requiredRoles.includes(rows[0].role)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      const lastActive = rows[0].last_active_at ? new Date(rows[0].last_active_at).getTime() : 0;
      if (Date.now() - lastActive > 5 * 60 * 1000) {
        pool.query('UPDATE users SET last_active_at = NOW() WHERE id = $1', [rows[0].id])
          .catch(err => console.error('[auth] touch failed:', err.message));
      }
      req.user = rows[0];
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
  };
}

/* ---------------- AUTH ---------------- */
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name, role, dpaConsent, emailOptin } = req.body || {};
  if (!email || !password || !name || !role) return res.status(400).json({ error: 'Missing fields' });
  if (!dpaConsent) return res.status(400).json({ error: 'DPA consent is required' });
  if (!['Resident', 'Responder', 'Admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (password.length < 6) return res.status(400).json({ error: 'Password too short' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, name, role, dpa_consent, email_optin)
       VALUES (LOWER($1), $2, $3, $4, TRUE, $5) RETURNING id`,
      [email, hash, name, role, !!emailOptin]
    );
    res.json({ id: rows[0].id });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email already registered' });
    console.error(e); res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Missing credentials' });
  const { rows } = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
  const user = rows[0];
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect email or password' });
  }
  await pool.query('UPDATE users SET last_active_at = NOW() WHERE id = $1', [user.id]);
  res.json({
    token: sign(user),
    user: { id: user.id, email: user.email, name: user.name, role: user.role }
  });
});

app.get('/api/auth/me', auth(), (req, res) => res.json({ user: req.user }));

/* ---------------- SERVICES ---------------- */
app.get('/api/services', auth(), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, description, is_active, created_by, created_at
     FROM services
     WHERE is_active = TRUE AND (created_by IS NULL OR created_by = $1)
     ORDER BY created_by NULLS FIRST, name`,
    [req.user.id]
  );
  res.json(rows);
});

app.post('/api/services', auth(), async (req, res) => {
  const { name, description } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  const trimmed = name.trim();
  try {
    const { rows: existing } = await pool.query(
      `SELECT id, is_active FROM services WHERE name = $1 AND created_by = $2 LIMIT 1`,
      [trimmed, req.user.id]
    );
    if (existing[0]) {
      if (existing[0].is_active) return res.status(409).json({ error: 'You already have a custom service with that name' });
      await pool.query(
        `UPDATE services SET is_active = TRUE, description = COALESCE($1, description) WHERE id = $2`,
        [description || null, existing[0].id]
      );
      const { rows } = await pool.query('SELECT * FROM services WHERE id = $1', [existing[0].id]);
      return res.json(rows[0]);
    }
    const { rows: global } = await pool.query(
      `SELECT 1 FROM services WHERE name = $1 AND created_by IS NULL AND is_active = TRUE LIMIT 1`, [trimmed]);
    if (global[0]) return res.status(409).json({ error: 'A default service with that name already exists' });
    const { rows } = await pool.query(
      `INSERT INTO services (name, description, created_by) VALUES ($1, $2, $3) RETURNING *`,
      [trimmed, description || null, req.user.id]
    );
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Name conflict' });
    console.error(e); res.status(500).json({ error: 'Failed to create service' });
  }
});

app.delete('/api/services/:id', auth(), async (req, res) => {
  const { rows } = await pool.query('SELECT id, created_by FROM services WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Service not found' });
  if (rows[0].created_by === null) return res.status(403).json({ error: 'Cannot delete default services' });
  if (rows[0].created_by !== req.user.id) return res.status(403).json({ error: 'You can only delete your own custom services' });
  const { rows: usage } = await pool.query('SELECT COUNT(*)::int AS c FROM appointments WHERE service_id = $1', [req.params.id]);
  if (usage[0].c > 0) {
    await pool.query('UPDATE services SET is_active = FALSE WHERE id = $1', [req.params.id]);
    return res.json({ ok: true, soft: true });
  }
  await pool.query('DELETE FROM services WHERE id = $1', [req.params.id]);
  res.json({ ok: true, soft: false });
});

/* ---------------- CATEGORIES ---------------- */
app.get('/api/categories', auth(), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, is_active, created_by
     FROM categories
     WHERE is_active = TRUE AND (created_by IS NULL OR created_by = $1)
     ORDER BY created_by NULLS FIRST, name`,
    [req.user.id]
  );
  res.json(rows);
});

app.post('/api/categories', auth(), async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  const trimmed = name.trim();
  try {
    const { rows: existing } = await pool.query(
      `SELECT id, is_active FROM categories WHERE name = $1 AND created_by = $2 LIMIT 1`,
      [trimmed, req.user.id]
    );
    if (existing[0]) {
      if (existing[0].is_active) return res.status(409).json({ error: 'You already have a custom category with that name' });
      await pool.query('UPDATE categories SET is_active = TRUE WHERE id = $1', [existing[0].id]);
      const { rows } = await pool.query('SELECT * FROM categories WHERE id = $1', [existing[0].id]);
      return res.json(rows[0]);
    }
    const { rows: global } = await pool.query(
      `SELECT 1 FROM categories WHERE name = $1 AND created_by IS NULL AND is_active = TRUE LIMIT 1`, [trimmed]);
    if (global[0]) return res.status(409).json({ error: 'A default category with that name already exists' });
    const { rows } = await pool.query(
      `INSERT INTO categories (name, created_by) VALUES ($1, $2) RETURNING *`,
      [trimmed, req.user.id]
    );
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Name conflict' });
    console.error(e); res.status(500).json({ error: 'Failed to create category' });
  }
});

app.delete('/api/categories/:id', auth(), async (req, res) => {
  const { rows } = await pool.query('SELECT id, created_by FROM categories WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Category not found' });
  if (rows[0].created_by === null) return res.status(403).json({ error: 'Cannot delete default categories' });
  if (rows[0].created_by !== req.user.id) return res.status(403).json({ error: 'You can only delete your own custom categories' });
  const { rows: usage } = await pool.query('SELECT COUNT(*)::int AS c FROM reports WHERE category_id = $1', [req.params.id]);
  if (usage[0].c > 0) {
    await pool.query('UPDATE categories SET is_active = FALSE WHERE id = $1', [req.params.id]);
    return res.json({ ok: true, soft: true });
  }
  await pool.query('DELETE FROM categories WHERE id = $1', [req.params.id]);
  res.json({ ok: true, soft: false });
});

/* ---------------- APPOINTMENTS ---------------- */
app.get('/api/appointments/slots', auth(), async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date required' });
  const { rows } = await pool.query(
    `SELECT time_slot FROM appointments WHERE appointment_date = $1 AND status <> 'REJECTED'`, [date]);
  res.json({ taken: rows.map(r => r.time_slot) });
});

app.get('/api/appointments', auth(), async (req, res) => {
  const base = `
    SELECT a.*, s.name AS service, u.name AS resident_name, u.email AS resident_email
    FROM appointments a
    JOIN services s ON s.id = a.service_id
    JOIN users u    ON u.id = a.resident_id`;
  const { rows } = req.user.role === 'Resident'
    ? await pool.query(base + ' WHERE a.resident_id = $1 ORDER BY a.created_at DESC', [req.user.id])
    : await pool.query(base + ' ORDER BY a.created_at DESC');
  res.json(rows);
});

app.post('/api/appointments', auth(['Resident']), async (req, res) => {
  const { serviceId, appointmentDate, timeSlot, purpose } = req.body || {};
  if (!serviceId || !appointmentDate || !timeSlot || !purpose) return res.status(400).json({ error: 'Missing fields' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO appointments (resident_id, service_id, appointment_date, time_slot, purpose)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, reference_no`,
      [req.user.id, serviceId, appointmentDate, timeSlot, purpose]
    );
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Time slot already taken' });
    console.error(e); res.status(500).json({ error: 'Booking failed' });
  }
});

app.patch('/api/appointments/:id', auth(['Admin']), async (req, res) => {
  const { status } = req.body || {};
  if (!['APPROVED', 'REJECTED', 'PENDING'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const { rows } = await pool.query(
    `UPDATE appointments SET status = $1, reviewed_by = $2 WHERE id = $3
     RETURNING resident_id, reference_no`, [status, req.user.id, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  await pool.query(
    `INSERT INTO notifications (user_id, message) VALUES ($1, $2)`,
    [rows[0].resident_id, `Your appointment ${rows[0].reference_no} was ${status.toLowerCase()}.`]
  );
  res.json({ ok: true });
});

app.delete('/api/appointments/:id', auth(['Resident','Admin']), async (req, res) => {
  const { rows } = await pool.query(
    'SELECT resident_id, status FROM appointments WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Appointment not found' });
  if (req.user.role === 'Resident') {
    if (rows[0].resident_id !== req.user.id) return res.status(403).json({ error: 'You can only delete your own appointments' });
    if (!['PENDING','REJECTED'].includes(rows[0].status)) {
      return res.status(400).json({ error: 'You can only delete pending or rejected appointments.' });
    }
  }
  await pool.query('DELETE FROM appointments WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

/* ---------------- REPORTS ---------------- */
const REPORT_VIEW = `SELECT * FROM v_reports_full`;

app.get('/api/reports', auth(), async (req, res) => {
  let rows;
  if (req.user.role === 'Resident') {
    ({ rows } = await pool.query(REPORT_VIEW + ' WHERE reporter_email = $1 ORDER BY created_at DESC', [req.user.email]));
  } else if (req.user.role === 'Responder') {
    ({ rows } = await pool.query(REPORT_VIEW + ' WHERE assigned_responder = $1 ORDER BY created_at DESC', [req.user.id]));
  } else {
    ({ rows } = await pool.query(REPORT_VIEW + ' ORDER BY created_at DESC'));
  }
  res.json(rows);
});

app.get('/api/reports/nearby', auth(['Resident']), async (req, res) => {
  const { categoryId, lat, lng } = req.query;
  if (!categoryId || !lat || !lng) return res.status(400).json({ error: 'Missing params' });
  const { rows } = await pool.query(
    `SELECT id, reference_no, address,
            ST_Y(location::geometry) AS latitude,
            ST_X(location::geometry) AS longitude
     FROM reports
     WHERE category_id = $1 AND status <> 'RESOLVED'
       AND ST_DWithin(location, ST_MakePoint($3, $2)::geography, 100)`,
    [categoryId, +lat, +lng]
  );
  res.json(rows);
});

async function findOrCreateCase(categoryId, lat, lng) {
  const { rows } = await pool.query(
    `SELECT id FROM cases
     WHERE category_id = $1 AND status IN ('OPEN','INVESTIGATING')
       AND ST_DWithin(location, ST_MakePoint($3, $2)::geography, 100)
     ORDER BY created_at DESC LIMIT 1`,
    [categoryId, +lat, +lng]
  );
  if (rows[0]) {
    await pool.query('UPDATE cases SET report_count = report_count + 1 WHERE id = $1', [rows[0].id]);
    return rows[0].id;
  }
  const ins = await pool.query(
    `INSERT INTO cases (category_id, location) VALUES ($1, ST_MakePoint($3, $2)::geography) RETURNING id`,
    [categoryId, +lat, +lng]
  );
  return ins.rows[0].id;
}

app.post('/api/reports', auth(['Resident']), upload.single('photo'), async (req, res) => {
  try {
    const { categoryId, type, address, description, latitude, longitude, appendToId } = req.body;
    if (!categoryId || !address || !description || !latitude || !longitude) return res.status(400).json({ error: 'Missing fields' });
    const lat = +latitude, lng = +longitude;
    if (lat < 4.5 || lat > 21.2 || lng < 116.8 || lng > 126.8) return res.status(400).json({ error: 'Location must be within the Philippines.' });

    if (appendToId) {
      const { rows } = await pool.query(
        'SELECT id, reference_no FROM reports WHERE id = $1 AND reporter_id = $2', [appendToId, req.user.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Report not found' });
      await pool.query(
        `UPDATE reports SET description = description || E'\\n[Resident Update] ' || $1,
         updates_count = updates_count + 1 WHERE id = $2`, [description, appendToId]);
      await pool.query(
        `INSERT INTO report_updates (report_id, author_id, update_type, body)
         VALUES ($1, $2, 'RESIDENT_UPDATE', $3)`, [appendToId, req.user.id, description]);
      return res.json({ id: rows[0].id, reference_no: rows[0].reference_no, appended: true });
    }

    const caseId = await findOrCreateCase(+categoryId, lat, lng);
    const { rows } = await pool.query(
      `INSERT INTO reports (reporter_id, category_id, case_id, report_type, address, location, description)
       VALUES ($1, $2, $3, $4, $5, ST_MakePoint($7, $6)::geography, $8)
       RETURNING id, reference_no`,
      [req.user.id, +categoryId, caseId, type || 'INCIDENT', address, lat, lng, description]
    );
    const reportId = rows[0].id;

    let aiSummary = 'No photo uploaded';
    let flagCount = 0;

    if (req.file) {
      const buffer = fs.readFileSync(req.file.path);
      const { rows: existing } = await pool.query(
        `SELECT rp.phash, r.reference_no FROM report_photos rp
         JOIN reports r ON r.id = rp.report_id WHERE rp.phash IS NOT NULL`);
      const { rows: cat } = await pool.query('SELECT name FROM categories WHERE id = $1', [+categoryId]);
      const screen = await screenPhoto({ buffer, mimeType: req.file.mimetype, category: cat[0]?.name || '', existingHashes: existing });
      await pool.query(
        `INSERT INTO report_photos (report_id, file_path, mime_type, phash, is_primary)
         VALUES ($1, $2, $3, $4, TRUE)`,
        [reportId, `/uploads/${req.file.filename}`, req.file.mimetype, screen.phash || '']
      );
      await pool.query(
        `INSERT INTO photo_checks (report_id, check_type, result, detail)
         VALUES ($1, 'PHASH_AND_SIGHTENGINE', $2, $3)`,
        [reportId, screen.flagCount > 0 ? 'FLAGGED' : 'CLEAN', screen.summary]
      );
      flagCount = screen.flagCount;
      aiSummary = screen.summary;
    }

    await pool.query('UPDATE reports SET ai_flag_count = $1, ai_summary = $2 WHERE id = $3',
      [flagCount, aiSummary, reportId]);
    res.json({ id: reportId, reference_no: rows[0].reference_no, ai_flag_count: flagCount, ai_summary: aiSummary });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Submission failed' });
  }
});

app.patch('/api/reports/:id/verify', auth(['Admin']), async (req, res) => {
  await pool.query(`UPDATE reports SET status = 'VERIFIED', verified_by = $1 WHERE id = $2 AND status = 'PENDING'`, [req.user.id, req.params.id]);
  res.json({ ok: true });
});
app.patch('/api/reports/:id/reject', auth(['Admin']), async (req, res) => {
  await pool.query(`UPDATE reports SET status = 'REJECTED' WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});
app.patch('/api/reports/:id/assign', auth(['Admin']), async (req, res) => {
  const { rows } = await pool.query(`SELECT id FROM users WHERE role = 'Responder' ORDER BY id LIMIT 1`);
  if (!rows[0]) return res.status(400).json({ error: 'No responder account available' });
  await pool.query(`UPDATE reports SET status = 'DISPATCHED', assigned_responder = $1 WHERE id = $2`, [rows[0].id, req.params.id]);
  await pool.query(`INSERT INTO tasks (report_id, responder_id, status) VALUES ($1, $2, 'ASSIGNED')`, [req.params.id, rows[0].id]);
  res.json({ ok: true });
});
app.patch('/api/reports/:id/start', auth(['Responder']), async (req, res) => {
  await pool.query(`UPDATE tasks SET status = 'IN_PROGRESS', started_at = NOW() WHERE report_id = $1 AND responder_id = $2 AND status = 'ASSIGNED'`, [req.params.id, req.user.id]);
  res.json({ ok: true });
});
app.patch('/api/reports/:id/done', auth(['Responder']), upload.single('proof'), async (req, res) => {
  const note = (req.body.proofNote || '').trim() || 'Field photo proof uploaded';
  const proofPath = req.file ? `/uploads/${req.file.filename}` : null;
  const { rows } = await pool.query(
    `UPDATE tasks SET status = 'DONE', completed_at = NOW()
     WHERE report_id = $1 AND responder_id = $2 AND status = 'IN_PROGRESS' RETURNING id`,
    [req.params.id, req.user.id]);
  if (rows[0]) {
    await pool.query(`INSERT INTO task_proofs (task_id, file_path, note) VALUES ($1, $2, $3)`, [rows[0].id, proofPath, note]);
  }
  res.json({ ok: true });
});
app.patch('/api/reports/:id/resolve', auth(['Admin']), async (req, res) => {
  await pool.query(`UPDATE reports SET status = 'RESOLVED' WHERE id = $1`, [req.params.id]);
  await pool.query(`UPDATE tasks SET status = 'CONFIRMED' WHERE report_id = $1 AND status = 'DONE'`, [req.params.id]);
  res.json({ ok: true });
});
app.patch('/api/reports/:id/return', auth(['Admin']), async (req, res) => {
  await pool.query(`UPDATE tasks SET status = 'IN_PROGRESS', completed_at = NULL WHERE report_id = $1 AND status = 'DONE'`, [req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/reports/:id', auth(['Resident','Admin']), async (req, res) => {
  const { rows } = await pool.query('SELECT reporter_id, status FROM reports WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Report not found' });
  if (req.user.role === 'Resident') {
    if (rows[0].reporter_id !== req.user.id) return res.status(403).json({ error: 'You can only delete your own reports' });
    if (!['PENDING','REJECTED'].includes(rows[0].status)) {
      return res.status(400).json({ error: 'You can only delete pending or rejected reports.' });
    }
  }
  await pool.query('DELETE FROM reports WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

/* ---------------- USERS ---------------- */
app.get('/api/users', auth(['Admin']), async (req, res) => {
  const { rows } = await pool.query(`
    SELECT id, email, name, role, account_status, dpa_consent, email_optin,
           created_at, last_active_at
    FROM users
    ORDER BY CASE role WHEN 'Admin' THEN 1 WHEN 'Responder' THEN 2 ELSE 3 END, name`);
  res.json(rows);
});

app.delete('/api/users/:id', auth(['Admin']), async (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  const { rows } = await pool.query('SELECT id, role FROM users WHERE id = $1', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  if (rows[0].role === 'Admin') {
    const { rows: admins } = await pool.query("SELECT COUNT(*)::int AS c FROM users WHERE role = 'Admin'");
    if (admins[0].c <= 1) return res.status(400).json({ error: 'Cannot delete the last admin account' });
  }
  await pool.query('DELETE FROM reports WHERE reporter_id = $1', [id]);
  await pool.query('DELETE FROM appointments WHERE resident_id = $1', [id]);
  await pool.query('UPDATE reports SET assigned_responder = NULL WHERE assigned_responder = $1', [id]);
  await pool.query('DELETE FROM services   WHERE created_by = $1', [id]);
  await pool.query('DELETE FROM categories WHERE created_by = $1', [id]);
  await pool.query('DELETE FROM users WHERE id = $1', [id]);
  res.json({ ok: true });
});

/* ---------------- ADVISORIES ---------------- */
app.get('/api/advisories', auth(), async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM advisories ORDER BY created_at DESC');
  res.json(rows);
});
app.post('/api/advisories', auth(['Admin']), async (req, res) => {
  const { title, severity, body } = req.body || {};
  if (!title || !severity || !body) return res.status(400).json({ error: 'Missing fields' });
  const { rows } = await pool.query(
    `INSERT INTO advisories (title, severity, body, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
    [title, severity, body, req.user.id]);
  const advId = rows[0].id;
  const { rows: residents } = await pool.query(`SELECT id FROM users WHERE role = 'Resident' AND email_optin = TRUE`);
  if (residents.length) {
    const values = residents.map((_, i) => `($1, $${i + 2}, 'QUEUED')`).join(',');
    const params = [advId, ...residents.map(r => r.id)];
    await pool.query(`INSERT INTO email_logs (advisory_id, user_id, status) VALUES ${values}`, params);
  }
  res.json({ id: advId, queued_emails: residents.length });
});

app.delete('/api/advisories/:id', auth(['Admin']), async (req, res) => {
  const { rows } = await pool.query('SELECT id FROM advisories WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Advisory not found' });
  await pool.query('DELETE FROM advisories WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

/* ---------------- NOTIFICATIONS ---------------- */
app.get('/api/notifications', auth(), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`, [req.user.id]);
  res.json(rows);
});

/* ---------------- STATS ---------------- */
app.get('/api/stats', auth(), async (req, res) => {
  if (req.user.role === 'Resident') {
    const { rows } = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM appointments WHERE resident_id = $1)::int AS appointments,
         (SELECT COUNT(*) FROM reports      WHERE reporter_id  = $1)::int AS reports,
         (SELECT COUNT(*) FROM appointments WHERE resident_id = $1 AND status = 'PENDING')::int +
         (SELECT COUNT(*) FROM reports      WHERE reporter_id  = $1 AND status = 'PENDING')::int AS pending,
         (SELECT COUNT(*) FROM advisories)::int AS advisories`,
      [req.user.id]);
    return res.json(rows[0]);
  }
  if (req.user.role === 'Admin') {
    const { rows } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM reports WHERE status <> 'RESOLVED')::int AS active_reports,
        (SELECT COUNT(*) FROM reports WHERE ai_flag_count > 0)::int   AS flagged_photos,
        (SELECT COUNT(*) FROM appointments WHERE status = 'PENDING')::int AS pending_appointments,
        (SELECT COUNT(*) FROM reports WHERE status = 'RESOLVED')::int AS resolved
    `);
    return res.json(rows[0]);
  }
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM tasks WHERE responder_id = $1 AND status = 'ASSIGNED')::int AS assigned,
      (SELECT COUNT(*) FROM tasks WHERE responder_id = $1 AND status = 'IN_PROGRESS')::int AS in_progress,
      (SELECT COUNT(*) FROM tasks WHERE responder_id = $1 AND status IN ('DONE','CONFIRMED'))::int AS done,
      (SELECT COUNT(*) FROM reports WHERE assigned_responder = $1 AND status <> 'RESOLVED')::int AS urgent
  `, [req.user.id]);
  res.json(rows[0]);
});

/* ---------------- CSV EXPORTS ---------------- */
app.get('/api/export/appointments.csv', auth(['Admin']), async (req, res) => {
  const { rows } = await pool.query(`
    SELECT a.reference_no, a.appointment_date, a.time_slot, s.name AS service,
           u.name AS resident, a.purpose, a.status, a.created_at
    FROM appointments a JOIN services s ON s.id = a.service_id JOIN users u ON u.id = a.resident_id
    ORDER BY a.created_at DESC`);
  const csv = ['reference_no,date,slot,service,resident,purpose,status,created_at']
    .concat(rows.map(r => [r.reference_no, r.appointment_date, r.time_slot, r.service, r.resident, r.purpose, r.status, r.created_at]
      .map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')))
    .join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="appointments.csv"');
  res.send(csv);
});
app.get('/api/export/reports.csv', auth(['Admin']), async (req, res) => {
  const { rows } = await pool.query(`
    SELECT reference_no, category, address, description, status, ai_flag_count, ai_summary, reporter_name, created_at
    FROM v_reports_full ORDER BY created_at DESC`);
  const csv = ['reference_no,category,address,description,status,ai_flag_count,ai_summary,reporter,created_at']
    .concat(rows.map(r => [r.reference_no, r.category, r.address, r.description, r.status, r.ai_flag_count, r.ai_summary, r.reporter_name, r.created_at]
      .map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')))
    .join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="reports.csv"');
  res.send(csv);
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

(async () => {
  try { await pool.query('SELECT 1'); }
  catch (e) { console.error('❌ Cannot reach PostgreSQL:', e.message); process.exit(1); }
  app.listen(PORT, () => console.log(`Ugnay running on http://localhost:${PORT}`));
  process.on('SIGTERM', async () => { await pool.end(); process.exit(0); });
})();