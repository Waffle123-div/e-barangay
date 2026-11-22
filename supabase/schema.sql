-- E-Barangay System — Supabase PostgreSQL Schema & Idempotent Seeds
-- Consolidated from all 36 Laravel migrations

-- 1. Users
CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    user_id VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    username VARCHAR(100) UNIQUE,
    email VARCHAR(255) UNIQUE,
    email_verified_at TIMESTAMPTZ,
    phone_number VARCHAR(30) UNIQUE,
    contact_number VARCHAR(30),
    password VARCHAR(255),
    security_pin VARCHAR(255),
    google_id VARCHAR(255),
    role VARCHAR(50) NOT NULL DEFAULT 'Resident',
    status VARCHAR(50) NOT NULL DEFAULT 'incomplete',
    remember_token VARCHAR(100),

    -- Personal Info
    first_name VARCHAR(255),
    middle_name VARCHAR(255),
    last_name VARCHAR(255),
    suffix VARCHAR(20),
    birthdate DATE,
    age INTEGER,
    birthplace VARCHAR(255),
    gender VARCHAR(50),
    civil_status VARCHAR(50),
    nationality VARCHAR(100) DEFAULT 'Filipino',
    occupation VARCHAR(150),
    profile_picture VARCHAR(255),

    -- Address
    purok VARCHAR(100),
    sitio VARCHAR(100),
    house_number VARCHAR(50),
    street VARCHAR(150),
    barangay_address VARCHAR(150),
    municipality VARCHAR(150),
    province VARCHAR(150),
    zip_code VARCHAR(20),

    -- ID & Face Verification
    id_type VARCHAR(100),
    id_photo VARCHAR(255),
    id_expiry_date DATE,
    id_verified_at TIMESTAMPTZ,
    id_uploaded_at TIMESTAMPTZ,
    proof_of_residency VARCHAR(255),
    selfie_photo VARCHAR(255),
    face_verified_at TIMESTAMPTZ,

    -- Security
    two_factor_enabled BOOLEAN NOT NULL DEFAULT FALSE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Document Types
CREATE TABLE IF NOT EXISTS document_types (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(255) UNIQUE NOT NULL,
    description TEXT,
    fee NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    processing_days VARCHAR(100) NOT NULL DEFAULT '1-2 Business Days',
    requirements JSONB DEFAULT '[]'::jsonb,
    template_file VARCHAR(255),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Document Requests
CREATE TABLE IF NOT EXISTS document_requests (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    tracking_number VARCHAR(100) UNIQUE NOT NULL,
    last_name VARCHAR(255),
    first_name VARCHAR(255),
    middle_initial VARCHAR(10),
    contact_number VARCHAR(50),
    resident_email VARCHAR(255),
    purok VARCHAR(255),
    street VARCHAR(255),
    city VARCHAR(255) DEFAULT 'COGON EAST, CARMEN, CEBU',
    age VARCHAR(20),
    document_type_id BIGINT REFERENCES document_types(id) ON DELETE SET NULL ON UPDATE CASCADE,
    document_type VARCHAR(255),
    id_type VARCHAR(100),
    documents JSONB,
    attachments JSONB,
    priority VARCHAR(50) DEFAULT 'Normal',
    purpose TEXT,
    fee NUMERIC(10, 2),
    status VARCHAR(50) NOT NULL DEFAULT 'Pending',
    is_generated BOOLEAN NOT NULL DEFAULT FALSE,
    assigned_staff VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Community Concerns
CREATE TABLE IF NOT EXISTS community_concerns (
    id BIGSERIAL PRIMARY KEY,
    concern_id VARCHAR(30) UNIQUE NOT NULL,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    resident_name VARCHAR(150) NOT NULL,
    resident_email VARCHAR(255),
    contact_number VARCHAR(30),
    address TEXT,
    title VARCHAR(200) NOT NULL,
    category VARCHAR(100) NOT NULL,
    description TEXT NOT NULL,
    location VARCHAR(255) NOT NULL,
    incident_date DATE,
    photo_path VARCHAR(255),
    status VARCHAR(30) NOT NULL DEFAULT 'Pending',
    admin_remarks TEXT,
    updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Community Concern Remarks
CREATE TABLE IF NOT EXISTS community_concern_remarks (
    id BIGSERIAL PRIMARY KEY,
    community_concern_id BIGINT NOT NULL REFERENCES community_concerns(id) ON DELETE CASCADE,
    admin_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    remark TEXT NOT NULL,
    attachment_path VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Activity Logs
CREATE TABLE IF NOT EXISTS activity_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action VARCHAR(100) NOT NULL,
    description TEXT,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. Barangay Settings
CREATE TABLE IF NOT EXISTS barangay_settings (
    id BIGSERIAL PRIMARY KEY,
    key VARCHAR(255) UNIQUE NOT NULL,
    value TEXT,
    "group" VARCHAR(100) NOT NULL DEFAULT 'general',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 8. Notifications
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY,
    type VARCHAR(255) NOT NULL,
    notifiable_type VARCHAR(255) NOT NULL DEFAULT 'App\\Models\\User',
    notifiable_id BIGINT NOT NULL,
    data JSONB NOT NULL,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 9. Password Reset / Verification OTP Tokens
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    email VARCHAR(255) PRIMARY KEY,
    token VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 10. Sessions (PostgreSQL Express Session Store)
CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR(255) PRIMARY KEY,
    user_id BIGINT,
    ip_address VARCHAR(45),
    user_agent TEXT,
    payload TEXT NOT NULL,
    last_activity INTEGER NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_doc_requests_user_id ON document_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_doc_requests_status ON document_requests(status);
CREATE INDEX IF NOT EXISTS idx_doc_requests_created_at ON document_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_concerns_user_id ON community_concerns(user_id);
CREATE INDEX IF NOT EXISTS idx_concerns_category ON community_concerns(category);
CREATE INDEX IF NOT EXISTS idx_concerns_status ON community_concerns(status);
CREATE INDEX IF NOT EXISTS idx_concern_remarks_concern_id ON community_concern_remarks(community_concern_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_user_created ON activity_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_barangay_settings_group ON barangay_settings("group");
CREATE INDEX IF NOT EXISTS idx_notifications_notifiable ON notifications(notifiable_type, notifiable_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity);

-- Seed Default Users (admin@example.com / admin123, resident@example.com / password)
INSERT INTO users (user_id, name, email, password, role, status, birthdate, gender, email_verified_at, created_at, updated_at)
VALUES
    ('USR-00001', 'Admin User', 'admin@example.com', '$2a$12$5LTNT2TsQSRM63npq32CROUSLTv8KqUpYcsnslO8LVHPIkmfUp5Rq', 'Admin', 'active', '1990-01-01', 'Male', NOW(), NOW(), NOW()),
    ('USR-00002', 'Resident User', 'resident@example.com', '$2a$12$WOem1FJ.mRbw20bDpGXaxeUPLTZbv2eI0RPW5rmgdIA54gF4SkmLa', 'Resident', 'active', '1995-05-05', 'Female', NOW(), NOW(), NOW())
ON CONFLICT (email) DO NOTHING;

-- Seed 15 Official Document Types
INSERT INTO document_types (name, description, fee, processing_days, requirements, template_file, is_active, created_at, updated_at)
VALUES
    ('Barangay Clearance', 'General clearance certifying good moral character and residency for employment, legal, and identification purposes.', 50.00, '1-2 Business Days', '["Valid Government-Issued ID","Proof of Residence"]'::jsonb, 'document_templates/01_Barangay_Clearance_General.docx', TRUE, NOW(), NOW()),
    ('Barangay Clearance (General)', 'Official general barangay clearance document for multi-purpose employment, travel, and legal requirements.', 50.00, '1-2 Business Days', '["Valid Government-Issued ID","Proof of Residence"]'::jsonb, 'document_templates/01_Barangay_Clearance_General (1).docx', TRUE, NOW(), NOW()),
    ('Barangay Business Clearance', 'Official barangay clearance for business and trade activities located within the barangay for obtaining or renewing Mayor''s/Business Permit.', 200.00, '2-3 Business Days', '["Valid Government-Issued ID","DTI / SEC / CDA Registration","Barangay Inspection Report / Lease Contract"]'::jsonb, 'document_templates/02_Barangay_Business_Permit.docx', TRUE, NOW(), NOW()),
    ('Barangay Certification for Electric Connection', 'Barangay certification interposing no objection for CEBECO II / utility electric meter installation.', 50.00, '1-2 Business Days', '["Valid Government-Issued ID","Proof of Property Ownership / Lease","CEBECO II / Electric Application Form"]'::jsonb, 'document_templates/03_Electric_Connection_Cert.docx', TRUE, NOW(), NOW()),
    ('Acknowledgement Receipt', 'Official barangay acknowledgement receipt issued for payments, fees, donations, and official transactions.', 0.00, '1 Business Day', '["Valid Government-Issued ID","Official Transaction Reference"]'::jsonb, 'document_templates/04_Acknowledgement_Receipt.docx', TRUE, NOW(), NOW()),
    ('Senior Citizen Certification', 'Official certification certifying senior citizen status and active residency under the Barangay Senior Citizen Roster.', 0.00, 'Same Day', '["Senior Citizen ID or Birth Certificate (60+ years old)","Valid Government-Issued ID","Proof of Residence"]'::jsonb, 'document_templates/05_Senior_Citizen_Cert.docx', TRUE, NOW(), NOW()),
    ('Certification for Senior Citizen Cash Assistance', 'Certification verifying physical status and eligibility of a living senior citizen to claim local or national cash subsidy and financial grants.', 0.00, 'Same Day', '["Senior Citizen ID","Valid Government-Issued ID","Barangay Verification"]'::jsonb, 'document_templates/06_Senior_Cash_Assistance.docx', TRUE, NOW(), NOW()),
    ('Certification for Burial Assistance', 'Certification issued to authorized family members handling funeral arrangements and claiming burial financial assistance for a deceased resident.', 0.00, 'Same Day', '["Death Certificate (Certified True Copy)","Valid Government-Issued ID of Claimant","Senior Citizen ID of Deceased","Proof of Relationship"]'::jsonb, 'document_templates/07_Senior_Burial_Assistance.docx', TRUE, NOW(), NOW()),
    ('Certificate of Cohabitation', 'Certification attesting that common-law partners have lived together without formal marriage.', 50.00, '1-2 Business Days', '["Valid Government-Issued ID (Both Partners)","Joint Affidavit of Cohabitation / Proof of Joint Residency"]'::jsonb, 'document_templates/08_Certificate_of_Cohabitation.docx', TRUE, NOW(), NOW()),
    ('Barangay Certification (For Probation & Bail)', 'Certification attesting no derogatory blotter record for court probation supervision or bail approval.', 50.00, '1-2 Business Days', '["Valid Government-Issued ID","Court Order / Subpoena / Referral Letter","Proof of Residency"]'::jsonb, 'document_templates/10_Probation_Bail_Brgy_Cert.docx', TRUE, NOW(), NOW()),
    ('Barangay Certificate', 'General certification attesting to good moral standing, residency, and character.', 50.00, '1-2 Business Days', '["Valid Government-Issued ID","Proof of Residency"]'::jsonb, 'document_templates/11_General_Barangay_Certificate.docx', TRUE, NOW(), NOW()),
    ('Barangay Certification (R.A. 11261 - First Time Jobseeker)', 'Free official certification for first time jobseekers pursuant to Republic Act No. 11261.', 0.00, '1 Business Day', '["Valid ID / School ID / PSA Birth Certificate","Signed Oath of Undertaking"]'::jsonb, 'document_templates/12_First_Time_Jobseeker_Cert.docx', TRUE, NOW(), NOW()),
    ('Oath of Undertaking (R.A. 11261)', 'Sworn oath of undertaking executed by first time jobseekers pursuant to Republic Act No. 11261.', 0.00, '1 Business Day', '["Valid ID / School ID / PSA Birth Certificate","Signed Oath of Undertaking"]'::jsonb, 'document_templates/13_Oath_of_Undertaking_Jobseeker.docx', TRUE, NOW(), NOW()),
    ('Certificate of Indigency', 'Certifies that the resident belongs to an indigent family for medical, educational, or legal assistance.', 0.00, 'Same Day', '["Valid Government-Issued ID","Proof of Low / No Income"]'::jsonb, 'document_templates/indigency_template.docx', TRUE, NOW(), NOW()),
    ('Certificate of Residency', 'Official certification confirming bona fide residency in the barangay jurisdiction.', 50.00, '1-2 Business Days', '["Valid Government-Issued ID","Proof of Residence"]'::jsonb, 'document_templates/residency_template.docx', TRUE, NOW(), NOW())
ON CONFLICT (name) DO NOTHING;

-- Seed Default Barangay Settings
INSERT INTO barangay_settings (key, value, "group", created_at, updated_at)
VALUES
    ('barangay_name', 'Barangay Cogon East', 'barangay', NOW(), NOW()),
    ('municipality', 'Municipality of Carmen', 'barangay', NOW(), NOW()),
    ('province', 'Cebu', 'barangay', NOW(), NOW()),
    ('region', 'Central Visayas (Region VII)', 'barangay', NOW(), NOW()),
    ('barangay_tagline', 'Serbisyong Maaasahan, Tapat, at Makatao', 'barangay', NOW(), NOW()),
    ('barangay_logo', NULL, 'barangay', NOW(), NOW()),
    ('municipal_logo', NULL, 'barangay', NOW(), NOW()),
    ('barangay_captain', 'Hon. Punong Barangay', 'officials', NOW(), NOW()),
    ('barangay_secretary', 'Barangay Secretary', 'officials', NOW(), NOW()),
    ('barangay_treasurer', 'Barangay Treasurer', 'officials', NOW(), NOW()),
    ('barangay_hall_address', 'Barangay Hall, Cogon East, Carmen, Cebu', 'contact', NOW(), NOW()),
    ('official_contact', '(032) 555-0100', 'contact', NOW(), NOW()),
    ('emergency_hotline', '(032) 555-0100 / 911', 'contact', NOW(), NOW()),
    ('official_email', 'ebarangay.cogoneast@gmail.com', 'contact', NOW(), NOW()),
    ('office_hours', 'Monday – Friday: 8:00 AM – 5:00 PM', 'contact', NOW(), NOW()),
    ('payment_gcash_enabled', '1', 'payment', NOW(), NOW()),
    ('gcash_account_name', 'Barangay Cogon East Treasury', 'payment', NOW(), NOW()),
    ('gcash_account_number', '0917-987-6543', 'payment', NOW(), NOW()),
    ('gcash_qr_code', NULL, 'payment', NOW(), NOW()),
    ('payment_maya_enabled', '0', 'payment', NOW(), NOW()),
    ('maya_account_name', 'Barangay Cogon East', 'payment', NOW(), NOW()),
    ('maya_account_number', '0917-987-6543', 'payment', NOW(), NOW()),
    ('payment_instructions', 'Scan the QR code or send to the number above. Please make sure to save a screenshot of your payment receipt and reference number.', 'payment', NOW(), NOW()),
    ('default_processing_days', '2', 'documents', NOW(), NOW()),
    ('tracking_prefix', 'REQ', 'documents', NOW(), NOW()),
    ('online_requests_enabled', '1', 'documents', NOW(), NOW()),
    ('max_active_requests_per_resident', '3', 'documents', NOW(), NOW()),
    ('resident_verification_mode', 'manual', 'residents', NOW(), NOW()),
    ('minimum_registration_age', '15', 'residents', NOW(), NOW()),
    ('purok_list', E'Purok 1\nPurok 2\nPurok 3\nPurok 4\nPurok 5\nSitio Ilaya\nSitio Ibaba\nGreenwoods Village', 'residents', NOW(), NOW()),
    ('accepted_ids', E'Philippine Passport\nPhilSys National ID\nDriver''s License\nUMID / SSS ID\nVoter''s ID / Certification\nPostal ID\nPRC ID\nStudent ID (with Enrollment Form)', 'residents', NOW(), NOW()),
    ('announcement_enabled', '0', 'announcements', NOW(), NOW()),
    ('announcement_type', 'info', 'announcements', NOW(), NOW()),
    ('announcement_category', 'General Advisory', 'announcements', NOW(), NOW()),
    ('announcement_title', 'Public Advisory', 'announcements', NOW(), NOW()),
    ('announcement_message', 'Welcome to the official E-Barangay Online Portal. You may request certificates and clearances online 24/7.', 'announcements', NOW(), NOW()),
    ('announcement_action_url', NULL, 'announcements', NOW(), NOW()),
    ('announcement_action_text', 'Learn More', 'announcements', NOW(), NOW()),
    ('announcement_is_dismissible', '1', 'announcements', NOW(), NOW()),
    ('announcement_expiry_date', NULL, 'announcements', NOW(), NOW()),
    ('system_maintenance_mode', '0', 'system', NOW(), NOW()),
    ('session_timeout_minutes', '120', 'system', NOW(), NOW())
ON CONFLICT (key) DO NOTHING;

-- Ensure private Supabase Storage bucket exists when running inside Supabase
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'storage' AND table_name = 'buckets'
    ) THEN
        INSERT INTO storage.buckets (id, name, public)
        VALUES ('ebarangay-files', 'ebarangay-files', false)
        ON CONFLICT (id) DO NOTHING;
    END IF;
END $$;
