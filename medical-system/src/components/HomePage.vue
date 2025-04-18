<template>
  <div class="app-container">
    <!-- Main Content Area -->
    <main class="main-content">
      <header class="main-header">
        <div class="logo-container">
          <h3>Medical System</h3>
        </div>
        <nav class="header-nav">
          <button :class="['nav-button', { active: currentView === 'dashboard' }]" @click="goToDashboard">
            <span class="icon">📊</span>
            <span>Dashboard</span>
          </button>
          <button :class="['nav-button', { active: currentView === 'pendingNotes' }]" @click="goToPending">
            <span class="icon">⏱️</span>
            <span>Pending Notes</span>
          </button>
          <button :class="['nav-button', { active: currentView === 'completedVisits' }]" @click="goToCompleted">
            <span class="icon">✅</span>
            <span>Completed Visits</span>
          </button>
          <button class="nav-button" @click="showPatientLookup = true">
            <span class="icon">🔍</span>
            <span>Patient Search</span>
          </button>
          <button :class="['nav-button', { active: currentView === 'newPatient' }]" @click="goToNewPatient">
            <span class="icon">➕</span>
            <span>New Patient</span>
          </button>
        </nav>
        <div class="user-info">
          <span>User</span> 
          <span class="dropdown-icon">▼</span>
        </div>
      </header>
      <!-- Dashboard Content -->
      <div class="dashboard-content" v-if="currentView === 'dashboard'">
        <div class="content-header">
          <h2>Dashboard (Placeholder)</h2>
        </div>
        <p>Welcome! Select an option from the navigation above.</p>
      </div>
      <!-- Pending Notes Content -->
      <div class="dashboard-content" v-if="currentView === 'pendingNotes'">
        <div class="content-header">
          <h2>Pending Notes ({{ pendingPatients.length }})</h2>
          <button class="refresh-btn" @click="fetchPendingPatients" :disabled="isLoadingPending">
            {{ isLoadingPending ? '...' : '↻' }}
          </button>
        </div>
        <div v-if="pendingError" class="error-message">{{ pendingError }}</div>
        <div v-if="isLoadingPending" class="loading-message">Loading pending patients...</div>
        <div v-else-if="pendingPatients.length > 0" class="data-table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>Patient Name</th>
                <th>DOB</th>
                <th>Checked In Time</th> <!-- Assuming API provides this -->
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="patient in pendingPatients" :key="patient.patient_id"> <!-- Use patient_id as key -->
                <td>{{ patient.first_name }} {{ patient.last_name }}</td>
                <td>{{ patient.date_of_birth }}</td>
                <td>{{ patient.checked_in_time || 'N/A' }}</td> <!-- Display check-in time -->
                <td>
                  <button class="action-btn" @click="takePatient(patient)">
                    Take Patient
                  </button>
                  <button class="action-btn" @click="removePatient(patient.patient_id, patient.queue_entry_id)" style="margin-left: 5px;">
                    Remove Patient
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else>
          <p>No patients are currently pending.</p>
        </div>
        <button @click="toggleSOAPNoteCreator" class="btn btn-primary mt-4">Toggle SOAP Note Creator</button>
      </div>
      <!-- Completed Visits Content -->
      <div class="dashboard-content" v-if="currentView === 'completedVisits'">
        <h2>Today's Completed Visits</h2>
        
        <div class="controls">
          <button @click="fetchCompletedVisits()" :disabled="isLoadingCompleted" class="refresh-btn" title="Refresh completed visits for today">
             {{ isLoadingCompleted ? '...' : '↻ Refresh' }}
          </button>
        </div>

        <div v-if="completedError" class="error-message">{{ completedError }}</div>

        <div v-if="isLoadingCompleted" class="loading-message">Loading today's completed visits...</div>

        <div v-else-if="completedVisits.length > 0" class="data-table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>Patient Name</th>
                <th>DOB</th>
                <th>Note Created</th>
                <th>Note Type</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="visit in completedVisits" :key="visit.note_id">
                <td>{{ visit.first_name }} {{ visit.last_name }}</td>
                <td>{{ formatDate(visit.date_of_birth) }}</td>
                <td>{{ formatDateTime(visit.created_at) }}</td>
                <td>{{ visit.note_type || 'N/A' }}</td>
                <td>{{ visit.signed_status || 'N/A' }}</td>
                <td>
                  <button class="action-btn view-btn" @click="viewCompletedNote(visit)">
                    View Note
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-else>
          <p>No completed visits found for today.</p>
        </div>
      </div>
      <!-- New Patient Form View -->
      <div class="dashboard-content" v-if="currentView === 'newPatient'">
        <h2>Add New Patient</h2>
        <NewPatientForm @patient-added="handlePatientAdded" />
      </div>
      <!-- Patient Lookup Modal -->
      <PatientLookup 
        v-if="showPatientLookup" 
        @close="showPatientLookup = false" 
        @patient-selected="handlePatientSelectedForNotes" 
      />
    </main>
  </div>
</template>

<script setup>
import { ref, onMounted, defineEmits } from 'vue';
import NewPatientForm from './NewPatientForm.vue'; 
import PatientLookup from './PatientLookup.vue';   
import { post, get, del } from '@aws-amplify/api'; 
import { getCurrentUser, fetchAuthSession } from '@aws-amplify/auth'; 

// Emit definition
const emit = defineEmits(['start-soap-note']);

// --- State Management ---
const currentView = ref('dashboard'); 
const showPatientLookup = ref(false);

// State for Pending Notes (initialize empty/default)
const pendingPatients = ref([]);
const isLoadingPending = ref(false);
const pendingError = ref('');

// State for Completed Visits (initialize empty/default)
const completedVisits = ref([]);
const isLoadingCompleted = ref(false);
const completedError = ref('');

// State for current patient being seen
const currentPatient = ref(null);

// --- Navigation Functions ---
const goToDashboard = () => {
  currentView.value = 'dashboard';
};

const goToPending = () => {
  fetchPendingPatients(); // Fetch latest list when navigating to this view
  currentView.value = 'pendingNotes';
};

const goToCompleted = () => {
  console.log("Navigating to Completed Visits view.");
  currentView.value = 'completedVisits';
  // Fetch completed visits for today when navigating
  fetchCompletedVisits();
};

const goToNewPatient = () => {
  currentView.value = 'newPatient'; 
};

// --- API Interaction (Placeholders/Basic Structure) ---
const fetchPendingPatients = async () => {
  isLoadingPending.value = true;
  pendingError.value = '';
  pendingPatients.value = [];

  let idToken = '';
  try {
    const { tokens } = await fetchAuthSession();
    if (!tokens?.idToken) {
      throw new Error('No ID token found in session.');
    }
    idToken = tokens.idToken.toString();
  } catch (authError) {
    console.error('Authentication error:', authError);
    pendingError.value = 'Authentication error. Please sign out and sign back in.';
    isLoadingPending.value = false;
    return;
  }

  try {
    // Use the correct API name from your Amplify config
    const apiName = 'emrApi'; // Make sure this matches your `amplifyconfiguration.json`
    const path = '/queue';
    const options = {
      headers: { 
        Authorization: idToken 
      }
    };

    console.log(`Fetching pending patients from ${apiName}${path}`);
    const restOperation = get({ apiName, path, options });
    const response = await restOperation.response;
    const data = await response.body.json();
    pendingPatients.value = data.patients || []; // Assuming the API returns { patients: [...] }
    console.log('Pending patients fetched:', pendingPatients.value);
    if (pendingPatients.value.length === 0) {
      console.log("No pending patients returned from API.")
    }
  } catch (error) {
    console.error('Error fetching pending patients:', error);
    let errorMessage = error.message || 'Unknown error';

    // Log the raw error object for detailed inspection
    console.error('Raw API Error Object:', JSON.stringify(error, null, 2));

    // Attempt to extract status code if available, but don't rely on response body structure
    if (error.response && error.response.statusCode) {
      errorMessage = `Status ${error.response.statusCode}: ${errorMessage}`;
    }

    pendingError.value = `Error fetching pending patients: ${errorMessage}`;
  } finally {
    isLoadingPending.value = false;
  }
};

const fetchCompletedVisits = async () => {
  const today = new Date().toISOString().split('T')[0]; // Get YYYY-MM-DD in UTC
  
  isLoadingCompleted.value = true;
  completedError.value = null;
  completedVisits.value = []; // Clear previous list
  console.log(`Fetching completed visits for today: ${today}...`);

  let idToken = '';
  try {
    const { tokens } = await fetchAuthSession();
    if (!tokens?.idToken) {
      throw new Error('No ID token found in session.');
    }
    idToken = tokens.idToken.toString();
  } catch (authError) {
    console.error('Authentication error:', authError);
    completedError.value = 'Authentication error. Please sign out and sign back in.';
    isLoadingCompleted.value = false;
    return;
  }

  try {
    // Use the correct API name from your Amplify config
    const apiName = 'emrApi'; // Make sure this matches your `amplifyconfiguration.json`
    const path = `/notes?date=${today}`;
    const options = {
      headers: { 
        Authorization: idToken 
      }
    };

    console.log(`Fetching completed visits from ${apiName}${path}`);
    const restOperation = get({ apiName, path, options });
    const response = await restOperation.response;
    const data = await response.body.json();
    completedVisits.value = data.notes || []; // Assuming the API returns { notes: [...] }
    console.log('Completed visits fetched:', completedVisits.value);
    if (completedVisits.value.length === 0) {
      console.log("No completed visits returned from API.")
    }
  } catch (error) {
    console.error(`Error fetching completed visits for ${today}:`, error);
    let errorMessage = error.message || 'Unknown error';

    // Log the raw error object for detailed inspection
    console.error('Raw API Error Object:', JSON.stringify(error, null, 2));

    // Attempt to extract status code if available, but don't rely on response body structure
    if (error.response && error.response.statusCode) {
      errorMessage = `Status ${error.response.statusCode}: ${errorMessage}`;
    }

    completedError.value = `Error fetching completed visits: ${errorMessage}`;
  } finally {
    isLoadingCompleted.value = false;
  }
};

// Function to handle taking a patient (initiates SOAP note)
function takePatient(patient) {
  console.log('Taking patient:', patient);
  emit('start-soap-note', patient); // Emit event with patient data
}

const removePatient = async (patientId, queueEntryId) => {
  if (!queueEntryId) {
    console.error('Cannot remove patient: queueEntryId is missing');
    // TODO: Show user feedback
    return;
  }
  console.log(`Attempting to remove patient ${patientId} with queue entry ID ${queueEntryId}`);
  try {
    // Confirmation dialog
    if (!confirm('Are you sure you want to remove this patient from the queue?')) {
      return;
    }

    // *** MODIFIED: Explicitly fetch token and add header ***
    let session;
    try {
      // Use fetchAuthSession to get the current session including tokens
      session = await fetchAuthSession(); 
      console.log('Current auth session before API call:', session);
      
      // Check if we have an ID token (preferred by API Gateway) or Access Token
      const idToken = session.tokens?.idToken?.toString(); // Use toString() to get the JWT string
      if (!idToken) {
         console.error("Could not retrieve ID token from session!");
         alert("Authentication error. Please log out and log back in."); // User feedback
         return; // Stop execution
      }

      // Prepare headers
      const requestOptions = {
        headers: { 
          Authorization: idToken // Send the ID token directly
        }
      };
      console.log('Request options with explicit Authorization header:', requestOptions);

      // API call with explicit headers
      await del({ 
        apiName: 'emrApi', 
        path: `/queue/${queueEntryId}`,
        options: requestOptions // Pass the options here
      });
      console.log('Patient removed successfully from queue');

      // Refresh the pending patients list after removal
      fetchPendingPatients(); // Call the function to refresh the list

      // TODO: Add success notification
    } catch (authError) {
      console.error("Error fetching auth session or making API call:", authError);
      // Check if the error is specifically a 401 from the API Gateway response
      if (authError?.response?.status === 401) {
        alert("Authorization failed (401). Please ensure your session is valid and try logging in again.");
      } else {
        alert("Authentication error or API call failed. Please check console and log out/in."); // User feedback
      }
      return; // Stop execution
    }
    // *** END MODIFIED BLOCK ***

  } catch (error) { // This outer catch might now only catch errors from the confirmation dialog
    console.error('Error removing patient (unexpected outer catch):', error);
    alert("An unexpected error occurred while removing the patient."); // Generic error
  }
};

// --- Lifecycle Hooks ---
onMounted(() => {
  console.log('HomePage mounted');
  fetchPendingPatients(); // Initial fetch when component loads
});

// --- Form Handling (Placeholders) ---
const handleFormSubmission = () => {
  console.log('New patient form submitted successfully (handler placeholder).');
  currentView.value = 'dashboard'; 
};

const returnToDashboard = () => {
  console.log('Form cancelled (handler placeholder).');
  currentView.value = 'dashboard';
};

// --- Patient Lookup Handling ---
const handlePatientSelectedForNotes = (patient) => {
  console.log("Patient selected from lookup:", patient); // Placeholder
  currentPatient.value = patient; // Store selected patient
  currentView.value = 'noteTaking'; // Switch view (need to restore this view)
  showPatientLookup.value = false; // Close the lookup modal
};

const handlePatientAdded = () => {
  // Optionally refresh patient list or navigate back to dashboard
  console.log('Patient added event received');
  currentView.value = 'dashboard'; // Navigate back after adding
  // Potentially re-fetch patient lists if needed
};

const toggleSOAPNoteCreator = () => {
  // Add your logic here to toggle the SOAPNoteCreator component
  console.log('Toggle SOAP Note Creator button clicked');
};

const viewVisit = (visit) => {
  console.log('Viewing visit:', visit);
  // Add your logic here to view the visit
};

// Helper Functions
function formatDateTime(dateTimeString) {
  if (!dateTimeString) return 'N/A';
  try {
    const options = { 
        year: 'numeric', month: 'numeric', day: 'numeric', 
        hour: 'numeric', minute: 'numeric', hour12: true, 
        timeZone: 'America/Los_Angeles' // Optional: Specify timezone if needed
    };
    return new Intl.DateTimeFormat('en-US', options).format(new Date(dateTimeString));
  } catch (e) {
    console.error("Error formatting date:", dateTimeString, e);
    return dateTimeString; // Return original string if formatting fails
  }
}

function formatDate(dateString) {
  if (!dateString) return 'N/A';
  try {
      // Assuming dateString is YYYY-MM-DD
      const [year, month, day] = dateString.split('-');
      // Create date object using UTC to avoid timezone interpretation issues
      const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))); 
      const options = { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC' }; 
      return new Intl.DateTimeFormat('en-US', options).format(date);
  } catch (e) {
      console.error("Error formatting date:", dateString, e);
      return dateString; // Return original string if formatting fails
  }
}

// Event Handlers
function handleStartSOAP(patient) {
  console.log("Start SOAP Note clicked for patient:", patient);
  if (!patient || !patient.patient_id || !patient.queue_entry_id) {
    console.error("Invalid patient data for starting SOAP note:", patient);
    pendingError.value = "Cannot start note: Missing required patient information.";
    return;
  }
  emit('start-soap-note', {
    patientId: patient.patient_id,
    firstName: patient.first_name,
    lastName: patient.last_name,
    dob: patient.date_of_birth,
    queueEntryId: patient.queue_entry_id
  });
}

function viewCompletedNote(visit) {
  console.log("View Note clicked for visit:", visit);
  // TODO: Implement logic to display the details of the selected note
  // This might involve emitting an event to App.vue or using a modal.
  alert(`Viewing note ID: ${visit.note_id} (Implementation Pending)`);
}

</script>

<style scoped>
/* Basic Reset & App Container */
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: 'Inter', 'Segoe UI', Roboto, -apple-system, BlinkMacSystemFont, sans-serif;
  color: #333;
  background-color: #f5f7fa;
}

.app-container {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

/* Main Content Area */
.main-content {
  display: flex;
  flex-direction: column;
  flex-grow: 1;
}

/* Header */
.main-header {
  background: #fff;
  padding: 0.75rem 1.5rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.04);
}

.logo-container {
  display: flex;
  align-items: center;
}

.logo-container h3 {
  font-size: 1rem;
  font-weight: 600;
  color: #333;
}

.header-nav {
  display: flex;
  align-items: center;
  flex-grow: 1;
  justify-content: center;
  gap: 0.5rem;
}

.nav-button {
  display: flex;
  align-items: center;
  padding: 0.5rem 0.75rem;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: #555;
  font-size: 0.85rem;
  cursor: pointer;
  transition: all 0.2s ease;
}

.nav-button:hover, .nav-button.active {
  background: rgba(0, 0, 0, 0.05);
  color: #000;
}

.nav-button .icon {
  margin-right: 0.5rem;
  font-size: 1rem;
}

.user-info {
  display: flex;
  align-items: center;
  font-weight: 500;
  cursor: pointer;
  color: #333;
  font-size: 0.9rem;
}

.dropdown-icon {
  margin-left: 0.5rem;
  font-size: 0.8rem;
}

/* Dashboard Content Area */
.dashboard-content {
  padding: 1.5rem 2rem;
  flex-grow: 1;
}

.content-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
}

.content-header h2 {
  font-size: 1.25rem;
  font-weight: 600;
  color: #333;
}

.refresh-btn {
  background: transparent;
  border: none;
  font-size: 1.2rem;
  cursor: pointer;
  color: #666;
  transition: transform 0.3s ease;
}

.refresh-btn:hover {
  transform: rotate(180deg);
  color: #333;
}

/* Data Table */
.data-table-container {
  background: white;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
  overflow-x: auto; /* Allow horizontal scrolling on small screens */
}

.data-table {
  width: 100%;
  border-collapse: collapse;
}

.data-table th,
.data-table td {
  padding: 1rem;
  text-align: left;
  border-bottom: 1px solid #eee;
  white-space: nowrap; /* Prevent text wrapping */
}

.data-table th {
  background: #f9fafb;
  font-weight: 600;
  font-size: 0.85rem;
  color: #666;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.data-table tr:last-child td {
  border-bottom: none;
}

.action-btn {
  padding: 0.4rem 0.8rem;
  background: #1a73e8;
  color: white;
  border: none;
  border-radius: 4px;
  font-size: 0.85rem;
  cursor: pointer;
  transition: background-color 0.2s ease;
}

.action-btn:hover {
  background: #1557b0;
}

/* Form Container (for Lookup/NewPatient) */
.form-container {
  padding: 2rem;
  max-width: 1200px; /* Limit width */
  margin: 1rem auto; /* Center and add some margin */
  background: white;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

/* Utility Classes */
.error-message {
  color: #dc3545;
  background-color: #f8d7da;
  border: 1px solid #f5c6cb;
  padding: 10px;
  border-radius: 4px;
  margin-bottom: 15px;
}

.loading-message {
  padding: 10px;
  color: #555;
}

/* Note Taking Specific Styles */
.note-taking-view .note-area {
  background-color: #fff;
  padding: 20px;
  border-radius: 8px;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

.note-taking-view textarea {
  width: 100%;
  min-height: 300px;
  margin-top: 15px;
  margin-bottom: 15px;
  padding: 10px;
  border: 1px solid #ccc;
  border-radius: 4px;
  font-family: inherit;
  font-size: 1rem;
}

.note-taking-view button {
  padding: 0.6rem 1.2rem;
  background-color: #28a745; /* Green for save */
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.9rem;
}

.note-taking-view button:hover {
  background-color: #218838;
}
</style>
