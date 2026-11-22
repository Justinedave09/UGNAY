-- Ugnay schema — PostgreSQL 14+ / PostGIS 3+ (idempotent)
BEGIN;

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION generate_reference(prefix TEXT) RETURNS TEXT AS $$
  SELECT prefix || '-' || EXTRACT(YEAR FROM NOW())::INT::TEXT
      || '-' || LPAD(FLOOR(RANDOM() * 9000 + 1000)::INT::TEXT, 4, '0');
$$ LANGUAGE sql VOLATILE;

CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  email          TEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  name           TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('Resident','Admin','Responder')),
  dpa_consent    BOOLEAN NOT NULL DEFAULT FALSE,
  email_optin    BOOLEAN NOT NULL DEFAULT FALSE,
  account_status TEXT NOT NULL DEFAULT 'ACTIVE'
                 CHECK (account_status IN ('ACTIVE','SUSPENDED','DISABLED')),
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS services (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_services_global_name
  ON services(name) WHERE created_by IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_services_user_name
  ON services(name, created_by) WHERE created_by IS NOT NULL;

CREATE TABLE IF NOT EXISTS categories (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_global_name
  ON categories(name) WHERE created_by IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_user_name
  ON categories(name, created_by) WHERE created_by IS NOT NULL;

CREATE TABLE IF NOT EXISTS appointments (
  id               SERIAL PRIMARY KEY,
  reference_no     TEXT UNIQUE NOT NULL DEFAULT generate_reference('APT'),
  resident_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service_id       INTEGER NOT NULL REFERENCES services(id),
  appointment_date DATE NOT NULL,
  time_slot        TEXT NOT NULL,
  purpose          TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING','APPROVED','REJECTED','COMPLETED','CANCELLED')),
  reviewed_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointment_slot_unique
  ON appointments(appointment_date, time_slot) WHERE status <> 'REJECTED';
CREATE INDEX IF NOT EXISTS idx_appointments_resident ON appointments(resident_id);
CREATE INDEX IF NOT EXISTS idx_appointments_date     ON appointments(appointment_date);
DROP TRIGGER IF EXISTS trg_appointments_updated_at ON appointments;
CREATE TRIGGER trg_appointments_updated_at BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS boundaries (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL DEFAULT 'Barangay Jurisdiction',
  boundary_geom  GEOMETRY(POLYGON, 4326) NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_boundaries_geom ON boundaries USING GIST (boundary_geom);

CREATE TABLE IF NOT EXISTS cases (
  id            SERIAL PRIMARY KEY,
  case_no       TEXT UNIQUE NOT NULL DEFAULT generate_reference('CASE'),
  category_id   INTEGER NOT NULL REFERENCES categories(id),
  location      GEOGRAPHY(POINT, 4326) NOT NULL,
  location_key  TEXT,
  status        TEXT NOT NULL DEFAULT 'OPEN'
                CHECK (status IN ('OPEN','INVESTIGATING','RESOLVED','CLOSED')),
  report_count  INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cases_location ON cases USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_cases_category ON cases(category_id);
DROP TRIGGER IF EXISTS trg_cases_updated_at ON cases;
CREATE TRIGGER trg_cases_updated_at BEFORE UPDATE ON cases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS reports (
  id                 SERIAL PRIMARY KEY,
  reference_no       TEXT UNIQUE NOT NULL DEFAULT generate_reference('REP'),
  reporter_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id        INTEGER NOT NULL REFERENCES categories(id),
  case_id            INTEGER REFERENCES cases(id) ON DELETE SET NULL,
  report_type        TEXT NOT NULL DEFAULT 'INCIDENT'
                     CHECK (report_type IN ('INCIDENT','CONCERN')),
  address            TEXT NOT NULL,
  location           GEOGRAPHY(POINT, 4326) NOT NULL,
  description        TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING','VERIFIED','DISPATCHED','RESOLVED','REJECTED')),
  ai_flag_count      INTEGER NOT NULL DEFAULT 0,
  ai_summary         TEXT,
  updates_count      INTEGER NOT NULL DEFAULT 0,
  assigned_responder INTEGER REFERENCES users(id) ON DELETE SET NULL,
  verified_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reports_location  ON reports USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_reports_status    ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_reporter  ON reports(reporter_id);
CREATE INDEX IF NOT EXISTS idx_reports_responder ON reports(assigned_responder);
CREATE INDEX IF NOT EXISTS idx_reports_category  ON reports(category_id);
DROP TRIGGER IF EXISTS trg_reports_updated_at ON reports;
CREATE TRIGGER trg_reports_updated_at BEFORE UPDATE ON reports
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS report_photos (
  id           SERIAL PRIMARY KEY,
  report_id    INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  file_path    TEXT NOT NULL,
  mime_type    TEXT,
  phash        TEXT,
  is_primary   BOOLEAN NOT NULL DEFAULT FALSE,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_report_photos_report ON report_photos(report_id);
CREATE INDEX IF NOT EXISTS idx_report_photos_phash  ON report_photos(phash);

CREATE TABLE IF NOT EXISTS photo_checks (
  id          SERIAL PRIMARY KEY,
  report_id   INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  check_type  TEXT NOT NULL,
  result      TEXT NOT NULL,
  detail      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_photo_checks_report ON photo_checks(report_id);

CREATE TABLE IF NOT EXISTS report_updates (
  id            SERIAL PRIMARY KEY,
  report_id     INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  author_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  update_type   TEXT NOT NULL DEFAULT 'COMMENT',
  body          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_report_updates_report ON report_updates(report_id);

CREATE TABLE IF NOT EXISTS tasks (
  id            SERIAL PRIMARY KEY,
  report_id     INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  responder_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'ASSIGNED'
                CHECK (status IN ('ASSIGNED','IN_PROGRESS','DONE','CONFIRMED','RETURNED')),
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tasks_report    ON tasks(report_id);
CREATE INDEX IF NOT EXISTS idx_tasks_responder ON tasks(responder_id, status);
DROP TRIGGER IF EXISTS trg_tasks_updated_at ON tasks;
CREATE TRIGGER trg_tasks_updated_at BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS task_proofs (
  id           SERIAL PRIMARY KEY,
  task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  file_path    TEXT,
  note         TEXT,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_task_proofs_task ON task_proofs(task_id);

CREATE TABLE IF NOT EXISTS advisories (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('INFO','WARNING','EMERGENCY')),
  body        TEXT NOT NULL,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_advisories_created ON advisories(created_at DESC);

CREATE TABLE IF NOT EXISTS email_logs (
  id           SERIAL PRIMARY KEY,
  advisory_id  INTEGER REFERENCES advisories(id) ON DELETE SET NULL,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'QUEUED'
               CHECK (status IN ('QUEUED','SENT','FAILED')),
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_email_logs_status ON email_logs(status);
CREATE INDEX IF NOT EXISTS idx_email_logs_user   ON email_logs(user_id);

CREATE TABLE IF NOT EXISTS notifications (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message     TEXT NOT NULL,
  is_read     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE VIEW v_reports_full AS
SELECT
  r.id, r.reference_no, r.status, r.report_type, r.address,
  ST_Y(r.location::geometry) AS latitude,
  ST_X(r.location::geometry) AS longitude,
  r.description, r.ai_flag_count, r.ai_summary, r.updates_count,
  r.created_at, r.updated_at,
  c.name       AS category,
  u.name       AS reporter_name,
  u.email      AS reporter_email,
  ru.name      AS responder_name,
  r.assigned_responder,
  (SELECT file_path FROM report_photos WHERE report_id = r.id AND is_primary LIMIT 1) AS photo_path,
  t.status     AS task_status,
  (SELECT note FROM task_proofs WHERE task_id = t.id ORDER BY uploaded_at DESC LIMIT 1) AS task_proof
FROM reports r
JOIN categories c ON c.id = r.category_id
JOIN users u      ON u.id = r.reporter_id
LEFT JOIN users ru ON ru.id = r.assigned_responder
LEFT JOIN tasks t  ON t.report_id = r.id AND t.status <> 'RETURNED'
GROUP BY r.id, c.name, u.name, u.email, ru.name, t.status, t.id;

COMMIT;