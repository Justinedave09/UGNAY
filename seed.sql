BEGIN;

INSERT INTO users (email, password_hash, name, role, dpa_consent, email_optin)
VALUES
  ('resident@ugnay.gov.ph',  crypt('password123', gen_salt('bf', 10)), 'AppDev Resident (Group 1)',  'Resident',  TRUE, TRUE),
  ('admin@ugnay.gov.ph',     crypt('password123', gen_salt('bf', 10)), 'Group 1 Admin',              'Admin',     TRUE, TRUE),
  ('responder@ugnay.gov.ph', crypt('password123', gen_salt('bf', 10)), 'Group 1 Responder Unit',     'Responder', TRUE, TRUE)
ON CONFLICT DO NOTHING;

INSERT INTO services (name, description) VALUES
  ('Certificate of Residency',            'Proof of residency'),
  ('Barangay Clearance',                   'General clearance'),
  ('Certificate of Indigency',             'Financial assistance'),
  ('Barangay Business Permit Endorsement', 'Business endorsement'),
  ('Barangay ID Application',              'Barangay identification')
ON CONFLICT DO NOTHING;

INSERT INTO categories (name) VALUES
  ('Flood / Clogged Drainage'),
  ('Fire Hazard / Smoke'),
  ('Road Obstruction / Fallen Tree'),
  ('Medical Emergency'),
  ('Security / Peace & Order')
ON CONFLICT DO NOTHING;

INSERT INTO boundaries (name, boundary_geom)
SELECT 'Barangay Jurisdiction (Caloocan test)',
       ST_GeomFromText('POLYGON((
         120.9795 14.6545,
         120.9890 14.6545,
         120.9890 14.6470,
         120.9795 14.6470,
         120.9795 14.6545
       ))', 4326)
WHERE NOT EXISTS (SELECT 1 FROM boundaries LIMIT 1);

INSERT INTO advisories (title, severity, body) VALUES
  ('Heavy Rainfall & Drainage Clearing Advisory', 'WARNING',
   'Barangay response teams are conducting declogging operations along Purok 1 to Purok 4. Please avoid parking near drainage inlets.'),
  ('Weekend Mobile Barangay Clearance & ID Issuance', 'INFO',
   'Residents with approved appointments may claim their certificates at the Barangay Hall Covered Court from 8:00 AM to 4:00 PM.');

INSERT INTO settings (key, value) VALUES
  ('phash_threshold',   '12'::jsonb),
  ('duplicate_radius_m','100'::jsonb),
  ('email_from',        '"no-reply@ugnay.gov.ph"'::jsonb)
ON CONFLICT DO NOTHING;

COMMIT;