# Multi-Tenant EMR System (Vue/Vite Frontend + AWS Backend)

## Project Goal

To build a Software-as-a-Service (SaaS) application that works as a very basic easy to use EMR system for medical clinics.


*   **Multi-Tenancy:** Each clinic's data must be strictly isolated from other clinics. The chosen approach is a shared database with separate schemas per tenant (clinic).
*   **Scalable Backend:** Utilize AWS serverless technologies (Lambda, API Gateway, Aurora Serverless v2) for a scalable and cost-effective backend.
*   **Secure Authentication:** Implement user authentication and authorization using AWS Cognito.
*   **Modern Frontend:** (Future Goal) Develop a user-friendly frontend using Vue.js and Vite.

## Technology Stack

*   **Frontend:**
    *   Vue.js 3
    *   Vite (Build Tool)
    *   AWS Amplify JS Library (for Cognito integration)
*   **Backend:**
    *   AWS Lambda (Node.js runtime)
    *   AWS API Gateway (REST API)
    *   `pg` (Node-Postgres library for DB connection)
*   **Database:**
    *   AWS Aurora Serverless v2 (PostgreSQL compatible)
*   **Authentication:**
    *   AWS Cognito
*   **Infrastructure & Deployment:**
    *   Terraform (Infrastructure as Code)
    *   AWS Secrets Manager (for DB credentials)
*   **Development Tools:**
    *   AWS CLI
    *   AWS Systems Manager (SSM) Port Forwarding (for local DB connection)

## API Usage Notes

### Authenticated API Calls with Amplify

**Issue:** When calling API Gateway endpoints secured with Cognito User Pools via the AWS Amplify `API` module (e.g., `API.get`, `API.del`), the `Authorization` header containing the JWT token might not be automatically added to the request, even if the API is configured with `AMAZON_COGNITO_USER_POOLS` in `main.js`. This results in a 401 Unauthorized error from API Gateway.

**Workaround:** Explicitly fetch the current user's session token using `fetchAuthSession` from `@aws-amplify/auth` and manually add the ID token as an `Authorization` header in the `options` parameter of the API call.

**Example (`API.get`):**

```javascript
import { fetchAuthSession } from '@aws-amplify/auth';
import { get } from '@aws-amplify/api';

async function fetchData() {
  try {
    const session = await fetchAuthSession();
    const idToken = session.tokens?.idToken?.toString(); // Or accessToken
    if (!idToken) {
      throw new Error("Authentication token not found.");
    }

    const requestOptions = {
      headers: {
        Authorization: idToken
      }
    };

    const response = await get({
      apiName: 'emrApi', // Your API name defined in Amplify config
      path: '/your-protected-path',
      options: requestOptions
    });

    console.log('Data fetched:', response);
    // ... process response
  } catch (error) {
    console.error('Error fetching data:', error);
    // Handle errors, e.g., redirect to login if 401
  }
}
```

Apply this pattern to all authenticated requests made using the Amplify `API` module (`get`, `post`, `put`, `del`, `head`).

## Current Status (Infrastructure & Setup - April 14, 2025)

The core AWS backend infrastructure has been provisioned using Terraform (`/terraform` directory):

*   **Networking:**
    *   Custom VPC (`emr_vpc`) with public and private subnets across multiple Availability Zones.
    *   Internet Gateway (IGW) for public subnets.
    *   NAT Gateway for private subnets to allow outbound internet access (e.g., for Lambda accessing AWS APIs).
    *   Route tables configured for public and private traffic flow.
*   **API & Lambda:**
    *   API Gateway (`emr_api`) with a default `/dev` stage and proxy routing (`/{proxy+}`) to the backend Lambda.
    *   Node.js 18 Lambda function (`emr-backend-lambda`) configured within the private subnets.
    *   IAM Role (`emr-lambda-execution-role`) with necessary permissions for VPC access and Secrets Manager access.
    *   Lambda code skeleton exists in `/lambda_code` using `@aws-sdk/client-secrets-manager` and `pg` for database connections.
*   **Database:**
    *   Aurora Serverless v2 PostgreSQL cluster (`emr-aurora-cluster`) provisioned in private subnets.
    *   An initial database instance (`emr-aurora-instance-1`) of type `db.t3.medium`.
    *   Database `emrdb` created with master user `emr_admin`.
    *   Credentials securely managed via AWS Secrets Manager (current secret ARN: `arn:aws:secretsmanager:us-east-1:198109036860:secret:rds!cluster-...`).
    *   RDS Security Group (`emr-rds-sg`) configured to allow traffic from the Lambda function's SG and the SSM Bastion's SG.
*   **Authentication:**
    *   Cognito User Pool (`emr_user_pool`) set up.
    *   Cognito App Client (`emr_app_client`) configured for web usage.
*   **Development/Debugging Access:**
    *   An EC2 instance (`emr-ssm-bastion`) within the VPC's public subnet, configured with an IAM role for SSM access.
    *   Connectivity to the private RDS database from a local machine is established via SSM Port Forwarding through this bastion instance.

## Feature: SOAP Note Creation (Implemented April 15, 2025)

The basic flow for creating and saving a SOAP note for a patient taken from the waiting queue has been implemented:

1.  **Patient Selection (`HomePage.vue`):**
    *   User clicks "Take Patient" button next to a patient in the "Pending Patients" list.
    *   `HomePage.vue` emits a `start-soap-note` event containing the selected `patient` object.

2.  **Component Activation (`App.vue`):**
    *   `App.vue` listens for the `start-soap-note` event.
    *   It stores the received `patient` data in a reactive variable (`currentPatientForNote`).
    *   It sets a flag (`showSOAPNoteCreator`) to true, which conditionally renders the `SOAPNoteCreator.vue` component.
    *   The `patient` data is passed as a prop to `SOAPNoteCreator.vue`.

3.  **Note Entry (`SOAPNoteCreator.vue`):**
    *   The component displays the selected patient's name and ID.
    *   Input fields are provided for Subjective, Objective, Assessment, Plan, ICD-10 Code, and CPT Code.
    *   User fills in the details and clicks "Save Note".

4.  **API Call (`SOAPNoteCreator.vue` - `saveNote` function):**
    *   The `saveNote` function gathers the input data.
    *   It uses `fetchAuthSession` from `@aws-amplify/auth` to get the current user's Cognito ID token.
    *   It constructs a payload object including `patient_id` and note details.
    *   It makes a `POST` request to the `/soapnotes` path of the `emrApi` using `API.post` from `@aws-amplify/api`.
    *   Crucially, it includes the `Authorization: <idToken>` header in the request options (as per the workaround noted in 'API Usage Notes').

5.  **Backend Processing (API Gateway -> Lambda -> RDS):**
    *   API Gateway receives the `POST /soapnotes` request.
    *   The configured Cognito Authorizer validates the `Authorization` token.
    *   If valid, the request is proxied to the `emr-backend-lambda` function.
    *   The Lambda function (`lambda_code/index.js`) handles the event:
        *   Parses the request body.
        *   Validates necessary fields (e.g., `patient_id`).
        *   Connects to the Aurora PostgreSQL database using the `pg` pool and credentials fetched from Secrets Manager.
        *   Formats the `icd10_code` and `cpt_code` into JSONB structure for the `dx_codes` and `billing_codes` columns respectively.
        *   Executes an `INSERT` statement into the `clinic_test.notes` table, mapping payload fields (e.g., `subjective`) to table columns (e.g., `subjective_note`).
        *   Sets `note_type` to 'SOAP'.
        *   Returns a `201 Created` response containing the `note_id` and `created_at` timestamp of the newly inserted row.

6.  **UI Update (`SOAPNoteCreator.vue` -> `App.vue`):**
    *   Upon receiving the successful `201` response, `SOAPNoteCreator.vue` emits a `close-request` event.
    *   `App.vue` listens for this event and sets `showSOAPNoteCreator` back to `false`, hiding the component.

**Troubleshooting Points:**

*   **401 Unauthorized:** Ensure the Cognito token is being fetched correctly and added to the `Authorization` header in `SOAPNoteCreator.vue`'s `saveNote` function.
*   **400 Bad Request (API):** Check the Lambda CloudWatch logs. This could indicate missing required fields (`patient_id`) or invalid JSON in the request body sent from the frontend, or potentially an invalid `patient_id` causing a foreign key constraint violation during the database insert.
*   **500 Internal Server Error (API):** Check Lambda CloudWatch logs for database connection issues, SQL errors (e.g., incorrect column names, data type mismatches), or other unhandled exceptions within the Lambda function.
*   **CORS Errors:** Ensure the `OPTIONS` method is correctly configured for `/soapnotes` in API Gateway (Terraform config) to handle preflight requests from the browser.

## Key Milestones Achieved

*   Successfully provisioned the core AWS infrastructure using Terraform.
*   Resolved initial Lambda database connection issues (`ENOTFOUND` error) by ensuring the `aws_rds_cluster_instance` resource was correctly defined and provisioned in Terraform.
*   Established secure connectivity to the private RDS database from a local development environment using `psql` and AWS Systems Manager (SSM) Port Forwarding.
*   Decided on the multi-tenancy strategy: Shared Database, Separate Schemas.
*   Created initial database schema (`clinic_test`) and tables (`patients`, `notes`, `waiting_queue`) via manual SQL execution.

## Next Steps

1.  **Database Schema Definition & Creation:**
    *   Define the schema for the `notes` table.
    *   Connect to the database via `psql` (using SSM tunnel) and manually create the initial schema(s) (e.g., `CREATE SCHEMA clinic_test;`).
    *   Execute the `CREATE TABLE` scripts for `patients` and `notes` within the appropriate clinic schema(s).
2.  **Lambda Function Implementation:**
    *   Implement tenant identification logic (e.g., based on API request path, headers, or authenticated user).
    *   Modify database connection logic to dynamically set the PostgreSQL `search_path` based on the identified tenant for each request.
    *   Implement API route handlers (`/patients`, `/notes`, etc.) to perform CRUD operations against the database.
3.  **Cognito Integration:**
    *   Integrate Cognito authentication with API Gateway to secure endpoints.
    *   Pass authenticated user/tenant information to the Lambda function.
4.  **Frontend Development:**
    *   Set up the Vue/Vite frontend project.
    *   Implement user login/signup flows using Cognito.
    *   Build UI components to interact with the backend API for managing patients and notes.

## Database Schema Setup (PostgreSQL - Per Tenant Schema)

The following SQL commands describe the necessary schema objects that must be created **within each tenant's dedicated schema** (e.g., `clinic_test`, `clinic_abc`). These commands are typically executed automatically by the application during tenant onboarding.

The examples below use `clinic_test` as the schema name and assume the `uuid-ossp` extension and `public.trigger_set_timestamp()` function already exist in the database (created once globally).

**1. Ensure Global Objects Exist (Run Once in `public` schema or globally)**

```sql
-- Run once globally in the database if not already present
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create the timestamp update function (example from README)
-- CREATE OR REPLACE FUNCTION public.trigger_set_timestamp()...;
```

**2. Create `clinic_settings` Table (Run Per Clinic, within the clinic's schema)**

```sql
CREATE TABLE clinic_test.clinic_settings (
    setting_id INT PRIMARY KEY DEFAULT 1 CHECK (setting_id = 1),
    clinic_name VARCHAR(255) NOT NULL,
    custom_terms_conditions TEXT,
    custom_llm_instructions TEXT,
    cpt_fees JSONB DEFAULT '{}'::jsonb, -- Store as {"CPT_CODE": FEE_AMOUNT}
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Apply timestamp trigger
CREATE TRIGGER set_timestamp_clinic_settings
BEFORE UPDATE ON clinic_test.clinic_settings
FOR EACH ROW
EXECUTE FUNCTION public.trigger_set_timestamp();

-- Note: An initial row should be INSERTed during tenant creation.
-- Example: INSERT INTO clinic_test.clinic_settings (clinic_name) VALUES ('Example Clinic');
```

**3. Create `doctors` Table (Run Per Clinic, within the clinic's schema)**

```sql
CREATE TABLE clinic_test.doctors (
    doctor_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    full_name VARCHAR(150) NOT NULL,
    credentials VARCHAR(50), -- e.g., "MD", "DO", "NP"
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Apply timestamp trigger
CREATE TRIGGER set_timestamp_doctors
BEFORE UPDATE ON clinic_test.doctors
FOR EACH ROW
EXECUTE FUNCTION public.trigger_set_timestamp();

-- Optional: Index on name for lookups
CREATE INDEX idx_doctors_full_name ON clinic_test.doctors(full_name);
```

**4. Create `custom_form_fields` Table (Run Per Clinic, within the clinic's schema)**

```sql
CREATE TABLE clinic_test.custom_form_fields (
    field_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    form_area VARCHAR(100) NOT NULL, -- e.g., 'PATIENT_INTAKE', 'SOAP_SUBJECTIVE'
    field_label VARCHAR(255) NOT NULL,
    field_type VARCHAR(50) NOT NULL, -- e.g., 'TEXT', 'NUMBER', 'SELECT', 'CHECKBOX'
    options JSONB, -- For 'SELECT' type: [{"value": "opt1", "label": "Option 1"}, ...]
    is_required BOOLEAN DEFAULT FALSE,
    display_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Apply timestamp trigger
CREATE TRIGGER set_timestamp_custom_form_fields
BEFORE UPDATE ON clinic_test.custom_form_fields
FOR EACH ROW
EXECUTE FUNCTION public.trigger_set_timestamp();

-- Index for faster lookup by form area
CREATE INDEX idx_custom_form_fields_form_area ON clinic_test.custom_form_fields(form_area);
```

**5. Create `patients` Table (Run Per Clinic, within the clinic's schema)**

```sql
CREATE TABLE clinic_test.patients (
    patient_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    middle_initial CHAR(1),
    preferred_name VARCHAR(100),
    date_of_birth DATE NOT NULL,
    gender VARCHAR(50),
    phone_number VARCHAR(20),
    email VARCHAR(255) UNIQUE, -- Unique within the clinic
    address_line1 VARCHAR(255),
    address_line2 VARCHAR(255),
    city VARCHAR(100),
    state_province VARCHAR(100),
    postal_code VARCHAR(20),
    country VARCHAR(100),
    is_medicare_eligible BOOLEAN,
    custom_data JSONB, -- Store custom field values: {"field_uuid_1": "value", ...}
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Apply timestamp trigger
CREATE TRIGGER set_timestamp_patients
BEFORE UPDATE ON clinic_test.patients
FOR EACH ROW
EXECUTE FUNCTION public.trigger_set_timestamp();

-- Index for patients table
CREATE INDEX idx_patients_last_name ON clinic_test.patients(last_name);
```

**6. Create `notes` Table (Run Per Clinic, within the clinic's schema)**

```sql
CREATE TABLE clinic_test.notes (
    note_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    patient_id UUID NOT NULL,
    doctor_id UUID, -- Foreign key to doctors table
    note_type VARCHAR(50), -- e.g., 'SOAP', 'Intake', 'Progress'
    signed_status VARCHAR(20) DEFAULT 'Draft', -- e.g., 'Draft', 'Signed', 'Addendum'
    subjective_note TEXT,
    objective_note TEXT,
    assessment_note TEXT,
    plan_note TEXT,
    dx_codes JSONB, -- Store as ["ICD10:J06.9", "ICD10:R05"]
    billing_codes JSONB, -- Store as ["CPT:99213", "HCPCS:G0008"]
    custom_data JSONB, -- Store custom field values: {"field_uuid_1": "value", ...}
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_notes_patient
        FOREIGN KEY(patient_id)
        REFERENCES clinic_test.patients(patient_id)
        ON DELETE CASCADE,
    CONSTRAINT fk_notes_doctor
        FOREIGN KEY(doctor_id)
        REFERENCES clinic_test.doctors(doctor_id)
        ON DELETE SET NULL -- Or ON DELETE RESTRICT depending on requirements
);

-- Apply timestamp trigger
CREATE TRIGGER set_timestamp_notes
BEFORE UPDATE ON clinic_test.notes
FOR EACH ROW
EXECUTE FUNCTION public.trigger_set_timestamp();

-- Indexes for notes table
CREATE INDEX idx_notes_patient_id ON clinic_test.notes(patient_id);
CREATE INDEX idx_notes_doctor_id ON clinic_test.notes(doctor_id);
CREATE INDEX idx_notes_note_type ON clinic_test.notes(note_type);
```

**7. Create `waiting_queue` Table (Run Per Clinic, within the clinic's schema)**

```sql
CREATE TABLE clinic_test.waiting_queue (
    queue_entry_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    patient_id UUID NOT NULL REFERENCES clinic_test.patients(patient_id) ON DELETE CASCADE,
    queue_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status VARCHAR(20) DEFAULT 'waiting', -- e.g., 'waiting', 'in_progress', 'completed'
    notes TEXT
);

-- Optional: Add an index for faster lookups by status or patient
CREATE INDEX idx_waiting_queue_status ON clinic_test.waiting_queue(status);
CREATE INDEX idx_waiting_queue_patient_id ON clinic_test.waiting_queue(patient_id);
```

**8. Grant Permissions (Run Per Clinic, for the Lambda DB user)**

*Replace `clinic_test` with the actual schema name and `emr_admin` with the actual database username your Lambda function uses.*

```sql
GRANT USAGE ON SCHEMA clinic_test TO emr_admin;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE clinic_test.patients TO emr_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE clinic_test.notes TO emr_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE clinic_test.doctors TO emr_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE clinic_test.clinic_settings TO emr_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE clinic_test.custom_form_fields TO emr_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE clinic_test.waiting_queue TO emr_admin;

-- Optional: Grant permissions on sequences if needed
-- GRANT USAGE, SELECT ON SEQUENCE clinic_test.some_sequence_name TO emr_admin;
```

**9. Example: Inserting Test Data (Run Per Clinic, within the clinic's schema)**

*Replace `clinic_test` with the actual schema name.*

```sql
{{ ... }}
);

```

### Database Connection Details
