// Import required AWS SDK clients and Node.js modules
const { SecretsManagerClient, GetSecretValueCommand, ListSecretsCommand } = require("@aws-sdk/client-secrets-manager");
const { Pool } = require('pg');

// AWS Secrets Manager configuration
const clusterIdentifier = process.env.DB_CLUSTER_IDENTIFIER;
const region = process.env.AWS_REGION;

if (!clusterIdentifier || !region) {
    console.error("Missing required environment variables: DB_CLUSTER_IDENTIFIER or AWS_REGION");
    throw new Error("Missing required environment variables for DB connection."); // Fail fast on cold start
}

const secretsManagerClient = new SecretsManagerClient({ region: region });

let pool; // Define pool variable in a scope accessible by the handler
let cachedSecretArn = null; // Cache the secret ARN after finding it

// --- Helper Function to Validate Schema Name ---
// Basic validation: Allow alphanumeric characters and underscores, prevent SQL injection patterns
function isValidSchemaName(schemaName) {
    if (!schemaName) return false;
    // Must start with a letter or underscore, followed by letters, numbers, or underscores.
    // Adjust regex as needed based on your exact schema naming convention.
    const schemaRegex = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    return schemaRegex.test(schemaName);
}

// --- Helper Function to Set Search Path Safely ---
async function setTenantSearchPath(client, tenantSchema) {
    if (!isValidSchemaName(tenantSchema)) {
        console.error(`[Client ${client?.processID || 'N/A'}] Invalid tenant schema name provided: ${tenantSchema}`);
        throw new Error("Invalid tenant identifier.");
    }
    // Use pg's escapeIdentifier feature to safely quote the identifier
    const query = `SET search_path TO ${client.escapeIdentifier(tenantSchema)}, public;`;
    console.log(`[Client ${client?.processID || 'N/A'}] Executing search_path query: ${query}`); // Log the exact query being run
    try {
        await client.query(query);
        console.log(`[Client ${client?.processID || 'N/A'}] Search path set to '${tenantSchema}, public' for this connection.`);
    } catch (error) {
        console.error(`[Client ${client?.processID || 'N/A'}] ERROR executing SET search_path for tenant ${tenantSchema}:`, error);
        // Rethrow the error so the main handler catches it appropriately
        throw error;
    }
}

// --- Function to get database credentials from Secrets Manager ---
async function getDbCredentials() {
    const region = process.env.AWS_REGION; // Provided by Lambda runtime
    const clusterIdentifier = process.env.DB_CLUSTER_IDENTIFIER;
    const client = new SecretsManagerClient({ region });

    if (!clusterIdentifier) {
        console.error("DB_CLUSTER_IDENTIFIER environment variable not set.");
        throw new Error("Could not retrieve database credentials.");
    }
    console.log(`DB_CLUSTER_IDENTIFIER: ${clusterIdentifier}`);
    console.log(`AWS_REGION: ${region}`);

    // Use cached ARN if available
    if (cachedSecretArn) {
        console.log(`Using cached Secret ARN: ${cachedSecretArn}`);
    } else {
        // --- ARN Discovery Logic ---
        let secretArn = null;
        try {
            console.log(`Attempting to find secret ARN by listing secrets and checking tags for cluster identifier: ${clusterIdentifier}`);
            let nextToken;
            do {
                const command = new ListSecretsCommand({
                    IncludePlannedDeletion: false,
                    MaxResults: 100,
                    NextToken: nextToken,
                    SortOrder: 'desc'
                });
                const response = await client.send(command);
                console.log(`ListSecrets response: Found ${response.SecretList ? response.SecretList.length : 0} secrets on this page.`);

                if (response.SecretList && response.SecretList.length > 0) {
                    for (const secret of response.SecretList) {
                        if (secret.Tags) {
                            const clusterArnTag = secret.Tags.find(tag => tag.Key === 'aws:rds:primaryDBClusterArn');
                            if (clusterArnTag && clusterArnTag.Value && clusterArnTag.Value.includes(clusterIdentifier)) {
                                secretArn = secret.ARN;
                                console.log(`Found secret ARN via tag match: ${secretArn} (Name: ${secret.Name}, Tag: ${clusterArnTag.Key}=${clusterArnTag.Value})`);
                                break;
                            }
                        }
                    }
                    if (secretArn) break;
                }
                nextToken = response.NextToken;
            } while (nextToken && !secretArn);

            if (!secretArn) {
                 console.log("Secret ARN not found via tags. Attempting legacy secret name pattern lookup as fallback...");
                 // Heuristic: Extract last part of cluster ID for potential secret name match
                 const likelySecretPrefix = `rds!cluster-${clusterIdentifier.split('-').pop()}`;
                 console.log(`Constructed likely secret name prefix: ${likelySecretPrefix}`);
                 try {
                     const listCommand = new ListSecretsCommand({
                         Filters: [{ Key: "name", Values: [likelySecretPrefix] }],
                         MaxResults: 5 // Limit results for name search
                     });
                      console.log("Sending ListSecrets command with name filter (fallback):", likelySecretPrefix);
                     const listResponse = await client.send(listCommand);
                      console.log(`ListSecrets (fallback) response: Found ${listResponse.SecretList ? listResponse.SecretList.length : 0} secrets.`);

                     if (listResponse.SecretList && listResponse.SecretList.length > 0) {
                         // Potentially check tags here too if multiple matches
                         secretArn = listResponse.SecretList[0].ARN;
                         console.log(`Found potential secret ARN via name pattern fallback: ${secretArn} (Name: ${listResponse.SecretList[0].Name})`);
                     } else {
                         console.error("Could not find secret using legacy name pattern fallback either.");
                         throw new Error(`Secret not found via tags or name pattern for cluster: ${clusterIdentifier}`);
                     }
                 } catch (fallbackError) {
                     console.error("Error during legacy secret name pattern fallback:", fallbackError);
                     throw new Error(`Failed to find secret ARN via tags or name pattern: ${fallbackError.message}`);
                 }
            }

        } catch (error) {
            console.error("Error during secret ARN discovery:", error);
            // Avoid caching partial results or failures
            cachedSecretArn = null;
            throw new Error(`Could not retrieve secret ARN: ${error.message}`);
        }

         if (!secretArn) {
             console.error("Secret ARN could not be determined after all attempts.");
              cachedSecretArn = null; // Ensure no bad cache
             throw new Error("Unable to determine the Secret ARN for the DB cluster.");
         }

        cachedSecretArn = secretArn; // Cache the found ARN
        console.log(`Secret ARN determined and cached: ${cachedSecretArn}`);
    } // End ARN Discovery

    // --- Retrieve Secret Value ---
    try {
        const command = new GetSecretValueCommand({ SecretId: cachedSecretArn });
        const data = await client.send(command);

        if ('SecretString' in data) {
            const secret = JSON.parse(data.SecretString);
            // Prefer writer instance endpoint from secret if available
            console.log(`DEBUG: Value of process.env.DB_CLUSTER_ENDPOINT inside getDbCredentials: ${process.env.DB_CLUSTER_ENDPOINT}`); // Use DB_CLUSTER_ENDPOINT
            const host = secret.host || process.env.DB_CLUSTER_ENDPOINT; // Use DB_CLUSTER_ENDPOINT
            if (!host) {
                console.error("DB endpoint address is missing in secret and DB_CLUSTER_ENDPOINT env var."); // Update error message
                throw new Error("DB endpoint address not found.");
            }
            console.log(`Using DB host: ${host}`);
            return {
                host: host,
                port: secret.port || 5432,
                user: secret.username,
                password: secret.password,
                database: secret.dbname || process.env.DB_NAME || 'postgres', // Use dbname from secret, fallback
            };
        } else {
            console.error("Secret value is binary, not string. Handling not implemented.");
            throw new Error("Cannot handle binary secret value.");
        }
    } catch (error) {
        console.error("Error retrieving secret value:", error);
         // If retrieving fails, invalidate the cached ARN as it might be wrong/stale
         if (error.name === 'ResourceNotFoundException' || error.name === 'AccessDeniedException') {
             console.log("Invalidating potentially incorrect cached Secret ARN due to retrieval error.");
             cachedSecretArn = null;
         }
        throw new Error(`Could not retrieve database credentials: ${error.message}`);
    }
}

// --- Initialize the database connection pool ---
async function initializePool() {
    // Check if pool exists and has a valid connect method (basic health check)
    if (pool && typeof pool.connect === 'function') {
        console.log("Database pool already initialized and seems valid.");
        return;
    }
     if (pool) {
         console.warn("Existing pool object found but seems invalid. Attempting re-initialization.");
         // Attempt to end the potentially broken pool
         try { await pool.end(); } catch (endError) { console.warn("Error ending previous invalid pool:", endError); }
         pool = null; // Clear the invalid pool object
     }

    try {
        console.log("Initializing database connection pool...");
        const dbCredentials = await getDbCredentials();

        // Log the connection parameters being used
        console.log(`POOL_INIT: Connecting with host=${dbCredentials.host}, port=${dbCredentials.port}, database=${dbCredentials.database}, user=${dbCredentials.user}`);

        pool = new Pool({
            host: dbCredentials.host,
            port: dbCredentials.port,
            user: dbCredentials.user,
            password: dbCredentials.password,
            database: dbCredentials.database,
            ssl: {
                rejectUnauthorized: false // Set to true and provide CA cert in production if needed
            },
            // Pool configuration (adjust as needed)
            max: process.env.DB_POOL_MAX ? parseInt(process.env.DB_POOL_MAX, 10) : 5, // Example: Env var for pool size
            idleTimeoutMillis: 30000, // Close idle clients after 30s
            connectionTimeoutMillis: 10000, // 10s connection timeout
        });

        // Add error listener to the pool
         pool.on('error', (err, client) => {
             console.error('Unexpected error on idle client in pool', err);
             // Optional: Implement logic to remove the faulty client or re-initialize pool
             // For simplicity now, just logging. Consider more robust handling.
         });

        // Test connection on initialization
        const client = await pool.connect();
        try {
            console.log("Testing database connection...");
            const res = await client.query('SELECT NOW()');
            console.log("Database connection test successful:", res.rows[0]);
        } finally {
            client.release(); // Always release the client
        }
        console.log("Database pool initialized successfully.");

    } catch (error) {
        console.error("FATAL: Failed to initialize database pool:", error);
        // Prevent using a broken pool
        if (pool) {
             try { await pool.end(); } catch (endError) { console.warn("Error ending partially initialized pool:", endError); }
        }
        pool = null;
        throw error; // Re-throw to signal initialization failure
    }
}

// --- Main Lambda handler function ---
exports.handler = async (event) => {
    // Log the raw event only if debug logging is enabled (consider env var)
    // console.log("Received event:", JSON.stringify(event, null, 2));
    console.log(`Received ${event.httpMethod} request for ${event.path}`);


    let statusCode = 200;
    // Define CORS headers - restrict origin in production
    const headers = {
        'Access-Control-Allow-Origin': process.env.CORS_ALLOW_ORIGIN || '*', // Use env var for origin
        'Access-Control-Allow-Headers': 'Content-Type, Authorization', // Add other headers if needed
        'Access-Control-Allow-Methods': 'OPTIONS,POST,GET,PUT,DELETE', // Allowed methods
        'Content-Type': 'application/json'
    };
    let responseBody = {};

    // --- Handle OPTIONS preflight requests ---
     if (event.httpMethod === 'OPTIONS') {
         console.log("Handling OPTIONS preflight request");
         // Return allowed methods and headers
         return {
             statusCode: 204, // No Content
             headers: {
                 'Access-Control-Allow-Origin': process.env.CORS_ALLOW_ORIGIN || '*',
                 'Access-Control-Allow-Methods': 'OPTIONS,POST,GET,PUT,DELETE',
                 'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                 'Access-Control-Max-Age': 86400 // Cache preflight response for 1 day
             },
             body: '',
         };
     }

    // --- Ensure database pool is initialized (with retry mechanism on first call) ---
    if (!pool) {
        try {
            await initializePool();
        } catch (initError) {
            console.error("Error during database pool initialization or connection:", initError);
            statusCode = 500;
            responseBody = { message: "Internal Server Error: Could not connect to database.", error: initError.message };
            // Return immediately if pool initialization fails
            return {
                 statusCode: 500,
                 headers: headers,
                 body: JSON.stringify(responseBody),
            };
        }
    }

    // --- Extract Tenant ID from Cognito claims ---
    let tenantSchema = null;
    console.log('Inspecting Authorizer Context:', JSON.stringify(event.requestContext?.authorizer, null, 2)); // Added for debugging
    try {
        // Use optional chaining for safer access
        const claims = event.requestContext?.authorizer?.claims;
        if (claims && claims['custom:clinic_id']) {
            const rawTenantId = claims['custom:clinic_id'];
             // Perform basic validation/sanitization here before passing to isValidSchemaName
            if (typeof rawTenantId === 'string' && rawTenantId.trim().length > 0) {
                 tenantSchema = rawTenantId.trim(); // Trim whitespace
                 console.log(`Tenant ID (custom:clinic_id) found in claims: ${tenantSchema}`);
                // Further validation (like regex) happens in setTenantSearchPath
            } else {
                 console.warn(`Invalid or empty custom:clinic_id claim found: ${rawTenantId}`);
            }
        } else {
            console.warn("Tenant ID (custom:clinic_id) not found in event.requestContext.authorizer.claims");
        }
    } catch (claimError) {
        // Log unexpected errors during claim extraction
        console.error("Unexpected error accessing Cognito claims:", claimError);
    }


    // --- API Routing ---
    const path = event.path;
    const method = event.httpMethod;
    let client; // Declare client outside try blocks for finally clause

    try {
        // === Public / Health Check Endpoint (No Tenant Required) ===
         if (path === '/healthcheck' && method === 'GET') {
             console.log("Handling /healthcheck");
             let dbOk = false;
             try {
                 client = await pool.connect();
                 await client.query('SELECT 1'); // Simple query to check connectivity
                 dbOk = true;
             } catch (dbError) {
                 console.error("Health check failed to connect to DB:", dbError);
             } finally {
                  if (client) client.release();
             }
             responseBody = {
                 status: 'OK',
                 database_status: dbOk ? 'OK' : 'Unavailable',
                 timestamp: new Date().toISOString()
             };
             return { statusCode: 200, headers: headers, body: JSON.stringify(responseBody) };
         }


         // === Tenant-Specific Routes ===
         // Check for tenant ID AFTER handling public routes
         if (!tenantSchema) {
             console.error("Tenant ID (custom:clinic_id) is required for this operation but was not found or invalid.");
             // Return 401 Unauthorized or 403 Forbidden might be more appropriate
             // if the user is authenticated but lacks the necessary tenant claim.
             // Using 400 for now, assuming it's a malformed request/token setup issue.
             return {
                 statusCode: 400,
                 headers: headers,
                 body: JSON.stringify({ message: "Bad Request: Tenant identifier missing or invalid in user token." }),
             };
         }


        // === PATIENTS Endpoint ===
        if (path === '/patients' && method === 'GET') {
            console.log(`Handling GET /patients for tenant ${tenantSchema}`);
            try {
                client = await pool.connect();
                const clientId = client.processID || 'N/A'; 
                console.log(`[Client ${clientId}] Acquired for GET /patients`);
                await setTenantSearchPath(client, tenantSchema); // Set tenant context
                console.log(`[Client ${clientId}] Search path should now be set.`);
                // Example: Select specific columns
                const query = 'SELECT patient_id, first_name, last_name, date_of_birth, created_at, updated_at FROM patients ORDER BY last_name, first_name;'; 
                console.log(`[Client ${clientId}] Executing query: ${query}`);
                const result = await client.query(query);
                responseBody = result.rows;
                console.log(`[Client ${clientId}] Found ${result.rowCount} patients for tenant ${tenantSchema}.`);
                statusCode = 200;
            } catch (dbError) {
                console.error(`[Client ${client?.processID || 'N/A'}] Database error fetching patients for tenant ${tenantSchema}:`, dbError);
                 // Check if the error is due to the schema not existing (e.g., new tenant setup pending)
                 if (dbError.code === '3F000') { // invalid_schema_name
                     console.warn(`Schema '${tenantSchema}' not found.`);
                     statusCode = 404; // Not Found might be suitable
                     responseBody = { message: `Tenant schema '${tenantSchema}' not found.`, error: dbError.message };
                 } else {
                    statusCode = 500;
                    responseBody = { message: "Internal Server Error: Could not fetch patients.", error: dbError.message };
                 }
            } finally {
                if (client) {
                    const clientId = client.processID || 'N/A';
                    console.log(`[Client ${clientId}] Releasing client for GET /patients`);
                    client.release();
                } else {
                    console.log("[Client undefined] No client to release for GET /patients");
                }
            }
        }
        // === POST /patients ===
        else if (method === 'POST' && path === '/patients') {
            console.log(`POST /patients request for tenant ${tenantSchema}`);
            try { // Outer try for JSON parsing
                const body = JSON.parse(event.body || '{}');
                console.log("Parsed request body:", body);

                // --- Database operation try block ---
                try { 
                    // Basic validation (Add more comprehensive validation as needed)
                    if (!body.first_name || !body.last_name || !body.date_of_birth) {
                         statusCode = 400;
                         responseBody = { message: "Bad Request: Missing required patient fields (first_name, last_name, date_of_birth)." };
                    } else {
                        client = await pool.connect(); // Connect inside the inner try
                        await setTenantSearchPath(client, tenantSchema);

                        const insertQuery = `
                            INSERT INTO patients (
                                first_name, last_name, date_of_birth, middle_initial, preferred_name, 
                                gender, phone_number, email, address_line1, address_line2, city, 
                                state_province, postal_code, country, is_medicare_eligible, custom_data
                            )
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)
                            RETURNING patient_id, first_name, last_name, date_of_birth, created_at;
                        `;
                        // Map fields from body to the correct columns
                        const values = [
                            body.first_name,            // $1
                            body.last_name,             // $2
                            body.date_of_birth,         // $3
                            body.middle_initial || null, // $4
                            body.preferred_name || null, // $5
                            body.gender || null,          // $6
                            body.phone_number || null,    // $7
                            body.email || null,           // $8
                            body.address_line1 || null,   // $9
                            body.address_line2 || null,   // $10
                            body.city || null,            // $11
                            body.state_province || null,  // $12
                            body.postal_code || null,     // $13
                            body.country || null,         // $14
                            body.is_medicare_eligible || false, // $15 (Assuming default false)
                            JSON.stringify(body.custom_data || {}) // $16 (Keep as JSONB)
                        ];

                        console.log("Executing query:", insertQuery.replace(/\s+/g, ' ').trim()); // Don't log values in production if sensitive
                        const result = await client.query(insertQuery, values);

                        if (result.rows.length > 0) {
                            const newPatient = result.rows[0];
                            console.log(`Successfully created patient ${newPatient.patient_id} for tenant ${tenantSchema}`);
                            statusCode = 201; // Created
                            responseBody = {
                                message: "Patient created successfully.",
                                // Return only essential details or match GET response structure
                                patientId: newPatient.patient_id, 
                                // patient: newPatient // Avoid sending back ALL columns by default
                            };
                        } else {
                            console.error("Patient insert query executed but did not return the new patient details.");
                            throw new Error("Failed to retrieve created patient details after insert.");
                        }
                    }
                } catch (dbError) { // Inner catch for DB errors
                    console.error(`Database error creating patient for tenant ${tenantSchema}:`, dbError);
                    console.error("DB Error Code:", dbError.code);
                    console.error("DB Error Detail:", dbError.detail);

                    if (dbError.code === '23505') { // Unique violation (if you have unique constraints)
                        console.error(`Unique constraint violation: ${dbError.detail}`);
                        statusCode = 409; // Conflict
                        responseBody = { message: "Conflict: Patient data violates a unique constraint.", error: dbError.detail };
                    } else if (dbError.code === '22P02') { // Invalid text representation (e.g., bad date format, invalid JSONB)
                        console.error(`Invalid data format: ${dbError.message}`);
                        statusCode = 400; // Bad Request
                        responseBody = { message: "Bad Request: Invalid data format provided.", error: dbError.message };
                    } else if (dbError.code === '3F000') { // invalid_schema_name
                        console.warn(`Schema '${tenantSchema}' not found during patient insert.`);
                        statusCode = 404; // Or 500
                        responseBody = { message: `Tenant schema '${tenantSchema}' not found.`, error: dbError.message };
                    } else {
                       statusCode = 500;
                       responseBody = { message: "Internal Server Error: Could not create patient.", error: dbError.message };
                    }
                } finally {
                   if (client) client.release(); // Release client in finally of inner try
                }
            // Outer catch for parsing errors
            } catch (parseError) { 
                if (parseError instanceof SyntaxError) {
                    console.error("Error parsing request body JSON:", parseError);
                    statusCode = 400; // Bad Request
                    responseBody = { message: "Bad Request: Invalid JSON format in request body." };
                } else {
                    // Re-throw unexpected errors not related to parsing
                    console.error("Unexpected error during POST /patients processing:", parseError);
                    statusCode = 500;
                    responseBody = { message: "Internal Server Error", error: parseError.message };
                    // Potentially throw parseError; depends on overall error handling strategy
                }
            } 
        }
        // === PUT /patients/{id} ===
        else if (method === 'PUT' && path.startsWith('/patients/')) {
            const patientId = event.pathParameters?.id; // Extract patient ID from path
            console.log(`PUT /patients/${patientId} request for tenant ${tenantSchema}`);
            let client;

            if (!patientId) {
                statusCode = 400;
                responseBody = { message: "Bad Request: Missing patient ID in path." };
            } else {
                try {
                    const body = JSON.parse(event.body || '{}');
                    console.log("Request body:", body);

                    // Basic validation (require at least one field to update)
                    // You might want more specific validation based on your schema
                    if (Object.keys(body).length === 0) {
                        statusCode = 400;
                        responseBody = { message: "Bad Request: No fields provided for update." };
                    } else {
                        client = await pool.connect();
                        await setTenantSearchPath(client, tenantSchema);

                        // Construct dynamic UPDATE query (caution with complex objects)
                        const fields = [];
                        const values = [];
                        let paramIndex = 1;

                        // Map request body fields to DB columns safely
                        // Only include fields present in the body to allow partial updates
                        if (body.first_name !== undefined) { fields.push(`first_name = $${paramIndex++}`); values.push(body.first_name); }
                        if (body.last_name !== undefined) { fields.push(`last_name = $${paramIndex++}`); values.push(body.last_name); }
                        if (body.date_of_birth !== undefined) { fields.push(`date_of_birth = $${paramIndex++}`); values.push(body.date_of_birth); }
                        if (body.gender !== undefined) { fields.push(`gender = $${paramIndex++}`); values.push(body.gender); }
                        // For JSONB fields, ensure they are stringified
                        if (body.contact_info !== undefined) { fields.push(`contact_info = $${paramIndex++}`); values.push(JSON.stringify(body.contact_info || {})); }
                        if (body.address !== undefined) { fields.push(`address = $${paramIndex++}`); values.push(JSON.stringify(body.address || {})); }
                        if (body.insurance_info !== undefined) { fields.push(`insurance_info = $${paramIndex++}`); values.push(JSON.stringify(body.insurance_info || {})); }
                        if (body.medical_history !== undefined) { fields.push(`medical_history = $${paramIndex++}`); values.push(JSON.stringify(body.medical_history || {})); }
                        // Add updated_at timestamp
                        fields.push(`updated_at = CURRENT_TIMESTAMP`);


                        if (fields.length === 1) { // Only updated_at was added automatically
                             statusCode = 400;
                             responseBody = { message: "Bad Request: No updatable fields provided." };
                        } else {
                            values.push(patientId); // Add patientId for the WHERE clause

                            const updateQuery = `
                                UPDATE patients
                                SET ${fields.join(', ')}
                                WHERE patient_id = $${paramIndex}
                                RETURNING patient_id, first_name, last_name, date_of_birth, updated_at;
                            `;

                            console.log("Executing query:", updateQuery.replace(/\s+/g, ' ').trim());
                            const result = await client.query(updateQuery, values);

                            if (result.rowCount > 0) {
                                const updatedPatient = result.rows[0];
                                console.log(`Successfully updated patient ${updatedPatient.patient_id} for tenant ${tenantSchema}`);
                                statusCode = 200; // OK
                                responseBody = {
                                    message: "Patient updated successfully.",
                                    patient: updatedPatient
                                };
                            } else {
                                console.warn(`Patient with ID ${patientId} not found for tenant ${tenantSchema} during update.`);
                                statusCode = 404; // Not Found
                                responseBody = { message: `Patient with ID ${patientId} not found.` };
                            }
                        }
                    }
                } catch (dbError) {
                    console.error(`Database error updating patient ${patientId} for tenant ${tenantSchema}:`, dbError);
                    console.error("DB Error Code:", dbError.code);
                    console.error("DB Error Detail:", dbError.detail);

                    if (dbError.code === '23505') { // Unique violation
                        statusCode = 409; // Conflict
                        responseBody = { message: "Conflict: Update violates a unique constraint.", error: dbError.detail };
                    } else if (dbError.code === '22P02') { // Invalid text representation
                        statusCode = 400;
                        responseBody = { message: "Bad Request: Invalid data format provided for update.", error: dbError.message };
                    } else if (dbError.code === '3F000') { // invalid_schema_name
                        console.warn(`Schema '${tenantSchema}' not found during patient update.`);
                        statusCode = 404;
                        responseBody = { message: `Tenant schema '${tenantSchema}' not found.`, error: dbError.message };
                    } else {
                        statusCode = 500;
                        responseBody = { message: `Internal Server Error: Could not update patient ${patientId}.`, error: dbError.message };
                    }
                } finally {
                    if (client) client.release();
                }
            }
        }
        // === DELETE /patients/{id} ===
        else if (method === 'DELETE' && path.startsWith('/patients/')) {
            const patientId = event.pathParameters?.id; // Extract patient ID from path
            console.log(`DELETE /patients/${patientId} request for tenant ${tenantSchema}`);
            let client;

            if (!patientId) {
                statusCode = 400;
                responseBody = { message: "Bad Request: Missing patient ID in path." };
            } else {
                try {
                    client = await pool.connect();
                    await setTenantSearchPath(client, tenantSchema);

                    const deleteQuery = `DELETE FROM patients WHERE patient_id = $1;`;
                    const values = [patientId];

                    console.log("Executing query:", deleteQuery.trim());
                    const result = await client.query(deleteQuery, values);

                    if (result.rowCount > 0) {
                        console.log(`Successfully deleted patient ${patientId} for tenant ${tenantSchema}`);
                        statusCode = 200; // OK
                        responseBody = { message: `Patient ${patientId} deleted successfully.` };
                    } else {
                        console.warn(`Patient with ID ${patientId} not found for tenant ${tenantSchema} during delete.`);
                        statusCode = 404; // Not Found
                        responseBody = { message: `Patient with ID ${patientId} not found.` };
                    }
                } catch (dbError) {
                    console.error(`Database error deleting patient ${patientId} for tenant ${tenantSchema}:`, dbError);
                    console.error("DB Error Code:", dbError.code);
                    console.error("DB Error Detail:", dbError.detail);

                    // Handle foreign key constraints if deletion is blocked
                    if (dbError.code === '23503') {
                         console.error(`Cannot delete patient ${patientId} due to existing references (e.g., notes).`);
                         statusCode = 409; // Conflict
                         responseBody = { message: `Conflict: Cannot delete patient ${patientId} as they have related records (e.g., SOAP notes).`, error: dbError.detail };
                    } else if (dbError.code === '3F000') { // invalid_schema_name
                        console.warn(`Schema '${tenantSchema}' not found during patient delete.`);
                        statusCode = 404;
                        responseBody = { message: `Tenant schema '${tenantSchema}' not found.`, error: dbError.message };
                    } else {
                        statusCode = 500;
                        responseBody = { message: `Internal Server Error: Could not delete patient ${patientId}.`, error: dbError.message };
                    }
                } finally {
                    if (client) client.release();
                }
            }
        }

        // === WAITING QUEUE Endpoint ===
        else if (path === '/waiting-queue' && method === 'GET') {
             console.log(`Handling GET /waiting-queue for tenant: ${tenantSchema}`);
            let client;
            try {
                client = await pool.connect();
                await setTenantSearchPath(client, tenantSchema);

                // Query the waiting queue, order by timestamp
                const queryText = `
                    SELECT 
                        wq.queue_entry_id, 
                        wq.patient_id,
                        p.first_name, 
                        p.last_name, 
                        wq.queue_timestamp, 
                        wq.status, 
                        wq.notes 
                    FROM waiting_queue wq
                    JOIN patients p ON wq.patient_id = p.patient_id
                    ORDER BY wq.queue_timestamp ASC;
                `;
                const result = await client.query(queryText);

                console.log(`Successfully fetched ${result.rows.length} entries from waiting queue for tenant ${tenantSchema}.`);
                statusCode = 200;
                responseBody = result.rows; // Return the array of queue entries

            } catch (dbError) {
                console.error(`Database error fetching waiting queue for tenant ${tenantSchema}:`, dbError);
                 if (dbError.code === '42P01') { // undefined_table
                     statusCode = 500; 
                     responseBody = { message: `Internal Server Error: waiting_queue table not found in schema ${tenantSchema}.`, error: dbError.message };
                 } else if (dbError.code === '3F000') { // invalid_schema_name
                    console.warn(`Schema '${tenantSchema}' not found when fetching queue.`);
                    statusCode = 404; // Or 500 depending on desired behavior
                    responseBody = { message: `Tenant schema '${tenantSchema}' not found.`, error: dbError.message };
                 } else {
                    statusCode = 500;
                    responseBody = { message: `Internal Server Error: Could not fetch waiting queue.`, error: dbError.message };
                 }
            } finally {
                if (client) {
                    client.release();
                    console.log("DB client released for GET /queue");
                }
            }
        }

        // === SOAP NOTES Endpoint ===
        else if (path === '/soapnotes' && method === 'POST') {
            console.log(`Handling POST /soapnotes for tenant ${tenantSchema}`);
            let requestBody;
            try {
                // Basic body parsing and validation
                if (!event.body) throw new Error("Request body is missing.");
                requestBody = JSON.parse(event.body);
                 console.log("Parsed request body:", requestBody); 
                if (typeof requestBody !== 'object' || requestBody === null) throw new Error("Invalid JSON object in body.");
            } catch (parseError) {
                console.error("Error parsing request body:", parseError);
                return {
                    statusCode: 400,
                    headers: headers,
                    body: JSON.stringify({ message: `Bad Request: ${parseError.message}` }),
                };
            }

            // --- Validate required fields ---
            const { patient_id, subjective, objective, assessment, plan, dx_codes, billing_codes, doctor_id } = requestBody; 
             if (!patient_id) { 
                 console.error("Missing required field 'patient_id' in request body.");
                 return {
                     statusCode: 400,
                     headers: headers,
                     body: JSON.stringify({ message: "Bad Request: Missing required field 'patient_id'." }),
                 };
             }
             // Optional: Validate UUID format for IDs if needed
             // Optional: Validate structure of dx_codes/billing_codes (should be arrays of strings?)

             // --- Sanitize and prepare data for DB ---
             const dxCodes = (Array.isArray(dx_codes) && dx_codes.length > 0) ? JSON.stringify(dx_codes) : null;
             const billingCodes = (Array.isArray(billing_codes) && billing_codes.length > 0) ? JSON.stringify(billing_codes) : null;
             const doctorId = doctor_id || null; 

            // --- Database Interaction ---
            try {
                client = await pool.connect();
                await setTenantSearchPath(client, tenantSchema); // Set tenant context

                const insertNoteQuery = `
                    INSERT INTO notes (
                        patient_id,
                        doctor_id, 
                        subjective_note,
                        objective_note,
                        assessment_note,
                        plan_note,
                        dx_codes,
                        billing_codes,
                        note_type,
                        signed_status 
                        -- created_at, updated_at default in schema
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9) 
                    RETURNING note_id, created_at, updated_at, signed_status; 
                `;

                const values = [
                    patient_id,
                    doctorId, 
                    subjective || null,
                    objective || null,
                    assessment || null,
                    plan || null,
                    dxCodes,
                    billingCodes,
                    'SOAP' 
                ];

                console.log("Executing query:", insertNoteQuery.replace(/\s+/g, ' ').trim(), "with values:", values);
                const result = await client.query(insertNoteQuery, values);

                if (result.rows.length > 0) {
                    const newNote = result.rows[0];
                    console.log(`Successfully inserted SOAP note ${newNote.note_id} for tenant ${tenantSchema}`);
                    statusCode = 201; 
                    responseBody = {
                        message: "SOAP note created successfully.",
                        note: newNote 
                    };
                } else {
                    // This case should be rare with RETURNING clause if insert succeeds without error
                    console.error("Insert query executed without error but did not return the expected row.");
                    throw new Error("Failed to retrieve created note details after insert.");
                }
            } catch (dbError) {
                console.error(`Database error inserting SOAP note for tenant ${tenantSchema}:`, dbError);
                 console.error("DB Error Code:", dbError.code);
                 console.error("DB Error Detail:", dbError.detail); 

                 if (dbError.code === '23503') { // Foreign key violation
                     // Check the constraint name to see which FK failed (e.g., fk_notes_patient, fk_notes_doctor)
                     const field = dbError.constraint === 'fk_notes_patient' ? 'patient_id' : dbError.constraint === 'fk_notes_doctor' ? 'doctor_id' : 'related entity';
                     const idValue = dbError.constraint === 'fk_notes_patient' ? patient_id : doctorId;
                     console.error(`Foreign key violation on constraint '${dbError.constraint}'. Invalid ${field}: ${idValue}`);
                     statusCode = 400; 
                     responseBody = { message: `Bad Request: Invalid ${field} provided (${idValue}). It does not exist.` };
                 } else if (dbError.code === '22P02') { // Invalid text representation
                     console.error(`Invalid data format provided: ${dbError.message}`);
                     statusCode = 400;
                     // Provide a more specific error if possible based on dbError.detail or context
                     responseBody = { message: "Bad Request: Invalid data format provided.", error: dbError.message };
                 } else if (dbError.code === '3F000') { // invalid_schema_name
                     console.warn(`Schema '${tenantSchema}' not found during insert.`);
                     statusCode = 404; 
                     responseBody = { message: `Tenant schema '${tenantSchema}' not found.`, error: dbError.message };
                 } else {
                    // Generic server error for other DB issues
                    statusCode = 500;
                    responseBody = { message: "Internal Server Error: Could not save SOAP note.", error: dbError.message };
                 }
            } finally {
                if (client) client.release();
            }
        }
        // === GET /soapnotes (List, with potential filters) ===
        else if (method === 'GET' && path === '/soapnotes') {
            const patientId = event.queryStringParameters?.patient_id; 
            console.log(`GET /soapnotes request for tenant ${tenantSchema}` + (patientId ? ` filtering by patient_id ${patientId}` : ''));
            let client;

            try {
                client = await pool.connect();
                await setTenantSearchPath(client, tenantSchema);

                let selectQuery = `SELECT note_id, patient_id, doctor_id, note_type, created_at, updated_at, signed_status FROM notes`; 
                const values = [];
                const conditions = [];

                // Add filtering conditions
                if (patientId) {
                    conditions.push(`patient_id = $${values.length + 1}`);
                    values.push(patientId);
                }
                // Add other filters as needed (e.g., doctor_id, date range)
                // if (event.queryStringParameters?.doctor_id) { ... }
                // if (event.queryStringParameters?.start_date) { ... }

                if (conditions.length > 0) {
                    selectQuery += ` WHERE ${conditions.join(' AND ')}`;
                }

                selectQuery += ` ORDER BY created_at DESC;`; 

                console.log("Executing query:", selectQuery.replace(/\s+/g, ' ').trim());
                const result = await client.query(selectQuery, values);

                console.log(`Successfully retrieved ${result.rows.length} SOAP notes for tenant ${tenantSchema}` + (patientId ? ` for patient ${patientId}` : ''));
                statusCode = 200; 
                responseBody = {
                    message: "SOAP notes retrieved successfully.",
                    notes: result.rows 
                };

            } catch (dbError) {
                console.error(`Database error retrieving SOAP notes list for tenant ${tenantSchema}:`, dbError);
                console.error("DB Error Code:", dbError.code);
                console.error("DB Error Detail:", dbError.detail);

                 if (dbError.code === '22P02' && dbError.message.includes('invalid input syntax for type uuid') && patientId) {
                    // Handle case where the provided patient ID is not a valid UUID
                    console.warn(`Invalid UUID format provided for patient_id filter: ${patientId}`);
                    statusCode = 400; 
                    responseBody = { message: `Bad Request: Invalid format for patient_id filter '${patientId}'.` };
                } else if (dbError.code === '42703' && patientId) { // undefined_column (might happen if patient_id column doesn't exist) - adjust based on actual errors
                    console.error(`Query error, potentially invalid filter column used.`);
                     statusCode = 400; 
                     responseBody = { message: `Bad Request: Invalid filter parameter used.` };
                 } else if (dbError.code === '3F000') { // invalid_schema_name
                    console.warn(`Schema '${tenantSchema}' not found during SOAP notes list retrieval.`);
                    statusCode = 404;
                    responseBody = { message: `Tenant schema '${tenantSchema}' not found.`, error: dbError.message };
                } else {
                    statusCode = 500;
                    responseBody = { message: `Internal Server Error: Could not retrieve SOAP notes list.`, error: dbError.message };
                }
            } finally {
                if (client) client.release();
            }
        }
        // === GET /soapnotes/{id} ===
        else if (method === 'GET' && path.startsWith('/soapnotes/')) {
            const noteId = event.pathParameters?.id; 
            console.log(`GET /soapnotes/${noteId} request for tenant ${tenantSchema}`);
            let client;

            if (!noteId) {
                statusCode = 400;
                responseBody = { message: "Bad Request: Missing SOAP note ID in path." };
            } else {
                 // Optional: Validate if noteId is a valid format (e.g., UUID) if applicable
                 // if (!isValidUUID(noteId)) { ... }

                try {
                    client = await pool.connect();
                    await setTenantSearchPath(client, tenantSchema);

                    const selectQuery = `SELECT * FROM notes WHERE note_id = $1;`;
                    const values = [noteId];

                    console.log("Executing query:", selectQuery.trim());
                    const result = await client.query(selectQuery, values);

                    if (result.rows.length > 0) {
                        const note = result.rows[0];
                        console.log(`Successfully retrieved SOAP note ${noteId} for tenant ${tenantSchema}`);
                        statusCode = 200; 
                        responseBody = {
                            message: "SOAP note retrieved successfully.",
                            note: note 
                        };
                    } else {
                        console.warn(`SOAP note with ID ${noteId} not found for tenant ${tenantSchema}.`);
                        statusCode = 404; 
                        responseBody = { message: `SOAP note with ID ${noteId} not found.` };
                    }
                } catch (dbError) {
                    console.error(`Database error retrieving SOAP note ${noteId} for tenant ${tenantSchema}:`, dbError);
                    console.error("DB Error Code:", dbError.code);
                    console.error("DB Error Detail:", dbError.detail);

                    if (dbError.code === '22P02' && dbError.message.includes('invalid input syntax for type uuid')) {
                        // Handle case where the provided ID is not a valid UUID
                        console.warn(`Invalid UUID format provided for note ID: ${noteId}`);
                        statusCode = 400; 
                        responseBody = { message: `Bad Request: Invalid format for SOAP note ID '${noteId}'.` };
                    } else if (dbError.code === '3F000') { // invalid_schema_name
                        console.warn(`Schema '${tenantSchema}' not found during SOAP note retrieval.`);
                        statusCode = 404;
                        responseBody = { message: `Tenant schema '${tenantSchema}' not found.`, error: dbError.message };
                    } else {
                        statusCode = 500;
                        responseBody = { message: `Internal Server Error: Could not retrieve SOAP note ${noteId}.`, error: dbError.message };
                    }
                } finally {
                    if (client) client.release();
                }
            }
        }
        // === PUT /soapnotes/{id} ===
        else if (method === 'PUT' && path.startsWith('/soapnotes/')) {
            const noteId = event.pathParameters?.id;
            console.log(`PUT /soapnotes/${noteId} request for tenant ${tenantSchema}`);
            let client;

            if (!noteId) {
                statusCode = 400;
                responseBody = { message: "Bad Request: Missing SOAP note ID in path." };
            } else {
                try {
                    // Parse body first, might throw SyntaxError
                    const body = JSON.parse(event.body || '{}'); 
                    console.log("Parsed request body for PUT:", body);

                    // --- Database operation try block --- 
                    try { 
                        if (Object.keys(body).length === 0) {
                            statusCode = 400;
                            responseBody = { message: "Bad Request: No fields provided for update." };
                        } else {
                            client = await pool.connect();
                            await setTenantSearchPath(client, tenantSchema);

                            // Construct dynamic UPDATE query
                            const fields = [];
                            const values = [];
                            let paramIndex = 1;

                            // Map updatable fields 
                            if (body.subjective !== undefined) { fields.push(`subjective = $${paramIndex++}`); values.push(body.subjective); }
                            if (body.objective !== undefined) { fields.push(`objective = $${paramIndex++}`); values.push(body.objective); }
                            if (body.assessment !== undefined) { fields.push(`assessment = $${paramIndex++}`); values.push(body.assessment); }
                            if (body.plan !== undefined) { fields.push(`plan = $${paramIndex++}`); values.push(body.plan); }
                            // Add other updatable fields like dx_codes, billing_codes, signed_status if needed
                            fields.push(`updated_at = CURRENT_TIMESTAMP`);

                            if (fields.length === 1) { // Only updated_at added
                                statusCode = 400;
                                responseBody = { message: "Bad Request: No updatable SOAP note fields provided." };
                            } else {
                                values.push(noteId); // Add noteId for the WHERE clause
                                const updateQuery = `
                                    UPDATE soap_notes
                                    SET ${fields.join(', ')}
                                    WHERE note_id = $${paramIndex}
                                    RETURNING *; 
                                `;
                                console.log("Executing query:", updateQuery.replace(/\s+/g, ' ').trim());
                                const result = await client.query(updateQuery, values);
                                if (result.rowCount > 0) {
                                    const updatedNote = result.rows[0];
                                    console.log(`Successfully updated SOAP note ${updatedNote.note_id} for tenant ${tenantSchema}`);
                                    statusCode = 200; 
                                    responseBody = {
                                        message: "SOAP note updated successfully.",
                                        note: updatedNote
                                    };
                                } else {
                                    console.warn(`SOAP note with ID ${noteId} not found for tenant ${tenantSchema} during update.`);
                                    statusCode = 404; 
                                    responseBody = { message: `SOAP note with ID ${noteId} not found.` };
                                }
                            }
                        }
                    } catch (dbError) {
                        console.error(`Database error updating SOAP note ${noteId} for tenant ${tenantSchema}:`, dbError);
                        console.error("DB Error Code:", dbError.code);
                        console.error("DB Error Detail:", dbError.detail);
                        // Specific DB error handling (22P02, 23503, 3F000 etc.)
                        if (dbError.code === '22P02') { 
                           statusCode = 400;
                           responseBody = { message: "Bad Request: Invalid data format provided for SOAP note update.", error: dbError.message };
                        } else if (dbError.code === '23503') { 
                           statusCode = 400; 
                           responseBody = { message: "Bad Request: Update references an invalid entity (e.g., patient_id).", error: dbError.detail };
                       } else if (dbError.code === '3F000') { 
                           console.warn(`Schema '${tenantSchema}' not found during SOAP note update.`);
                           statusCode = 404;
                           responseBody = { message: `Tenant schema '${tenantSchema}' not found.`, error: dbError.message };
                       } else {
                           statusCode = 500;
                           responseBody = { message: `Internal Server Error: Could not update SOAP note ${noteId}.`, error: dbError.message };
                       }
                    } finally {
                        if (client) client.release();
                    }
                // --- Outer catch for parsing errors --- 
                } catch (parseError) { 
                    if (parseError instanceof SyntaxError) {
                        console.error("Error parsing request body JSON for SOAP note update:", parseError);
                        statusCode = 400;
                        responseBody = { message: "Bad Request: Invalid JSON format in request body." };
                    } else {
                        // Re-throw unexpected errors not related to parsing
                        console.error("Unexpected error during PUT /soapnotes/{id} processing:", parseError);
                        statusCode = 500;
                        responseBody = { message: "Internal Server Error", error: parseError.message };
                        // Potentially throw parseError; depends on overall error handling strategy
                    }
                } 
            } // End else block (noteId exists)
        }

        // === GET /queue ===
        else if (path === '/queue' && method === 'GET') {
            console.log(`Handling GET /queue for tenant: ${tenantSchema}`);
            let client;
            try {
                client = await pool.connect();
                await setTenantSearchPath(client, tenantSchema);

                // Query the waiting queue, order by timestamp
                const queryText = `
                    SELECT 
                        wq.queue_entry_id, 
                        wq.patient_id,
                        p.first_name, 
                        p.last_name, 
                        wq.queue_timestamp, 
                        wq.status, 
                        wq.notes 
                    FROM waiting_queue wq
                    JOIN patients p ON wq.patient_id = p.patient_id
                    ORDER BY wq.queue_timestamp ASC;
                `;
                const result = await client.query(queryText);

                console.log(`Successfully fetched ${result.rows.length} entries from waiting queue for tenant ${tenantSchema}.`);
                statusCode = 200;
                responseBody = result.rows; // Return the array of queue entries

            } catch (dbError) {
                console.error(`Database error fetching waiting queue for tenant ${tenantSchema}:`, dbError);
                 if (dbError.code === '42P01') { // undefined_table
                     statusCode = 500; 
                     responseBody = { message: `Internal Server Error: waiting_queue table not found in schema ${tenantSchema}.`, error: dbError.message };
                 } else if (dbError.code === '3F000') { // invalid_schema_name
                    console.warn(`Schema '${tenantSchema}' not found when fetching queue.`);
                    statusCode = 404; // Or 500 depending on desired behavior
                    responseBody = { message: `Tenant schema '${tenantSchema}' not found.`, error: dbError.message };
                 } else {
                    statusCode = 500;
                    responseBody = { message: `Internal Server Error: Could not fetch waiting queue.`, error: dbError.message };
                 }
            } finally {
                if (client) {
                    client.release();
                    console.log("DB client released for GET /queue");
                }
            }
        }

        // === Unknown Path ===
        else {
            console.log(`Path not found: ${path}`);
            statusCode = 404;
            responseBody = { message: "Not Found", requestedPath: path };
        }

    } catch (error) {
        // Catch unexpected errors (e.g., coding errors, unhandled exceptions)
        console.error("Unhandled error processing request:", error);
        statusCode = 500;
        responseBody = { message: "Internal Server Error", error: error.message };
        // Optional: Add error ID for tracking
        // const errorId = require('crypto').randomUUID();
        // console.error(`Error ID: ${errorId}`);
        // responseBody.errorId = errorId;
    }

    // --- Final Response ---
    console.log(`Returning response: Status ${statusCode}, Body length: ${JSON.stringify(responseBody).length}`);
    // Avoid logging full body in production if it contains sensitive data
    // console.log(`Returning response: Status ${statusCode}`);

    // Ensure CORS headers are always included
    const finalHeaders = {
        'Access-Control-Allow-Origin': '*', // Allow requests from any origin (adjust in production)
        'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token', // Add Authorization
        'Access-Control-Allow-Methods': 'OPTIONS,POST,GET,PUT,DELETE', // Methods allowed
        ...(headers || {}) // Include any headers set earlier (like for OPTIONS)
    };

    return {
        statusCode: statusCode,
        headers: finalHeaders, // Use the merged headers
        body: JSON.stringify(responseBody),
    };
};