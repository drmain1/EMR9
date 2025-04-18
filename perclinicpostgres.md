# SQL Commands for New Clinic Tenant Provisioning

This file contains the sequence of SQL commands required to set up the schema, tables, and permissions for a new clinic tenant within the multi-tenant EMR database.

**Placeholders:**

*   `new_clinic_schema`: Replace with the dynamically generated, unique schema name for the new clinic.
*   `your_lambda_db_user`: Replace with the actual database username the Lambda function uses.
*   `'New Clinic Name'`: Replace with the actual name of the clinic being onboarded.

**Prerequisites:**

*   The database user (`your_lambda_db_user`) must exist.
*   The `uuid-ossp` extension must be enabled globally in the database.
*   The `public.trigger_set_timestamp()` function (or equivalent) must exist globally.

---

## 1. Create Tenant Schema

```sql
CREATE SCHEMA IF NOT EXISTS new_clinic_schema;
```

---

## 2. Create `clinic_settings` Table

```sql
CREATE TABLE new_clinic_schema.clinic_settings (
    setting_id INT PRIMARY KEY DEFAULT 1 CHECK (setting_id = 1),
    clinic_name VARCHAR(255) NOT NULL,
    custom_terms_conditions TEXT,
    custom_llm_instructions TEXT,
    cpt_fees JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_timestamp_clinic_settings
BEFORE UPDATE ON new_clinic_schema.clinic_settings
FOR EACH ROW
EXECUTE FUNCTION public.trigger_set_timestamp();

-- Insert initial settings row
INSERT INTO new_clinic_schema.clinic_settings (clinic_name) VALUES ('New Clinic Name');
```

---

## 3. Create `doctors` Table

```sql
CREATE TABLE new_clinic_schema.doctors (
    doctor_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    full_name VARCHAR(150) NOT NULL,
    credentials VARCHAR(50),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_timestamp_doctors
BEFORE UPDATE ON new_clinic_schema.doctors
FOR EACH ROW
EXECUTE FUNCTION public.trigger_set_timestamp();

CREATE INDEX idx_doctors_full_name ON new_clinic_schema.doctors(full_name);
```

---

## 4. Create `custom_form_fields` Table

```sql
CREATE TABLE new_clinic_schema.custom_form_fields (
    field_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    form_area VARCHAR(100) NOT NULL,
    field_label VARCHAR(255) NOT NULL,
    field_type VARCHAR(50) NOT NULL,
    options JSONB,
    is_required BOOLEAN DEFAULT FALSE,
    display_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_timestamp_custom_form_fields
BEFORE UPDATE ON new_clinic_schema.custom_form_fields
FOR EACH ROW
EXECUTE FUNCTION public.trigger_set_timestamp();

CREATE INDEX idx_custom_form_fields_form_area ON new_clinic_schema.custom_form_fields(form_area);
```

---

## 5. Create `patients` Table

```sql
CREATE TABLE new_clinic_schema.patients (
    patient_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    middle_initial CHAR(1),
    preferred_name VARCHAR(100),
    date_of_birth DATE NOT NULL,
    gender VARCHAR(50),
    phone_number VARCHAR(20),
    email VARCHAR(255) UNIQUE,
    address_line1 VARCHAR(255),
    address_line2 VARCHAR(255),
    city VARCHAR(100),
    state_province VARCHAR(100),
    postal_code VARCHAR(20),
    country VARCHAR(100),
    is_medicare_eligible BOOLEAN,
    custom_data JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_timestamp_patients
BEFORE UPDATE ON new_clinic_schema.patients
FOR EACH ROW
EXECUTE FUNCTION public.trigger_set_timestamp();

CREATE INDEX idx_patients_last_name ON new_clinic_schema.patients(last_name);
```

---

## 6. Create `notes` Table

```sql
CREATE TABLE new_clinic_schema.notes (
    note_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    patient_id UUID NOT NULL,
    doctor_id UUID,
    note_type VARCHAR(50),
    signed_status VARCHAR(20) DEFAULT 'Draft',
    subjective_note TEXT,
    objective_note TEXT,
    assessment_note TEXT,
    plan_note TEXT,
    dx_codes JSONB,
    billing_codes JSONB,
    custom_data JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_notes_patient
        FOREIGN KEY(patient_id)
        REFERENCES new_clinic_schema.patients(patient_id)
        ON DELETE CASCADE,
    CONSTRAINT fk_notes_doctor
        FOREIGN KEY(doctor_id)
        REFERENCES new_clinic_schema.doctors(doctor_id)
        ON DELETE SET NULL
);

CREATE TRIGGER set_timestamp_notes
BEFORE UPDATE ON new_clinic_schema.notes
FOR EACH ROW
EXECUTE FUNCTION public.trigger_set_timestamp();

CREATE INDEX idx_notes_patient_id ON new_clinic_schema.notes(patient_id);
CREATE INDEX idx_notes_doctor_id ON new_clinic_schema.notes(doctor_id);
CREATE INDEX idx_notes_note_type ON new_clinic_schema.notes(note_type);
```

---

## 7. Create `waiting_queue` Table

```sql
CREATE TABLE new_clinic_schema.waiting_queue (
    queue_entry_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    patient_id UUID NOT NULL REFERENCES new_clinic_schema.patients(patient_id) ON DELETE CASCADE,
    queue_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status VARCHAR(20) DEFAULT 'waiting',
    notes TEXT
);

CREATE INDEX idx_waiting_queue_status ON new_clinic_schema.waiting_queue(status);
CREATE INDEX idx_waiting_queue_patient_id ON new_clinic_schema.waiting_queue(patient_id);
```

---

## 8. Grant Permissions

```sql
GRANT USAGE ON SCHEMA new_clinic_schema TO your_lambda_db_user;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE new_clinic_schema.patients TO your_lambda_db_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE new_clinic_schema.notes TO your_lambda_db_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE new_clinic_schema.doctors TO your_lambda_db_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE new_clinic_schema.clinic_settings TO your_lambda_db_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE new_clinic_schema.custom_form_fields TO your_lambda_db_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE new_clinic_schema.waiting_queue TO your_lambda_db_user;

-- Optional: Grant permissions on sequences if needed
-- GRANT USAGE, SELECT ON SEQUENCE new_clinic_schema.some_sequence_name TO your_lambda_db_user;