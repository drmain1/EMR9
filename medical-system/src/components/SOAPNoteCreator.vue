<template>
  <div class="soap-container">
    <div class="soap-content">
      <h2 v-if="!patient">Create SOAP Note</h2>
      <h2 v-else>SOAP Note for: {{ patient?.first_name }} {{ patient?.last_name }} (ID: {{ patient?.patient_id }})</h2>

      <div v-if="error" class="error-message">{{ error }}</div>

      <!-- SOAP Form -->
      <div class="soap-form">
        <!-- Subjective Section -->
        <div class="form-group subjective">
          <label>Subjective</label>
          <textarea
            v-model="soapData.subjective"
            placeholder="Patient's reported symptoms, concerns, and history"
            rows="4"
            class="soap-textarea"
          ></textarea>
        </div>

        <!-- Objective Section -->
        <div class="form-group objective">
          <label>Objective</label>
          <textarea
            v-model="soapData.objective"
            placeholder="Clinical observations, vital signs, test results"
            rows="4"
            class="soap-textarea"
          ></textarea>
        </div>

        <!-- Assessment Section -->
        <div class="form-group assessment">
          <label>Assessment</label>
          <textarea
            v-model="soapData.assessment"
            placeholder="Clinical assessment, diagnosis, reasoning"
            rows="4"
            class="soap-textarea"
          ></textarea>
        </div>

        <!-- Plan Section -->
        <div class="form-group plan">
          <label>Plan</label>
          <textarea
            v-model="soapData.plan"
            placeholder="Treatment plan, medications, follow-up instructions"
            rows="4"
            class="soap-textarea"
          ></textarea>
        </div>
      </div>

      <!-- Medical Coding (Simplified) -->
      <div class="coding-section">
        <h3>Medical Coding (Simplified)</h3>
        <div class="form-group coding-inputs">
           <label for="icd10">ICD-10 Code</label>
           <input type="text" id="icd10" v-model="icd10Code" placeholder="e.g., J00" class="code-input" />
        </div>
         <div class="form-group coding-inputs">
           <label for="cpt">CPT Code</label>
           <input type="text" id="cpt" v-model="cptCode" placeholder="e.g., 99213" class="code-input" />
        </div>
      </div>

      <!-- Action Buttons -->
      <div class="action-buttons">
        <button @click="saveNote" class="save-draft-button" :disabled="isLoading">
          {{ isLoading ? 'Saving...' : 'Save Note' }}
        </button>
      </div>

    </div>
  </div>
</template>

<script setup>
import { ref, reactive, defineProps, defineEmits, computed } from 'vue';
import { post } from '@aws-amplify/api';
import { fetchAuthSession } from '@aws-amplify/auth';

// --- Props and Emits ---
const props = defineProps({
  patient: { // Expecting the patient object passed from App.vue
    type: Object,
    default: null
  }
});

const emit = defineEmits(['close-request']);

// --- Reactive State ---
const soapData = reactive({
  subjective: '',
  objective: '',
  assessment: '',
  plan: ''
});
const icd10Code = ref('');
const cptCode = ref('');
const isLoading = ref(false);
const error = ref('');

// --- Computed Properties ---
// Basic validation - check if patient exists and at least one field is filled
const canSave = computed(() => {
  return props.patient && props.patient.patient_id && 
         (soapData.subjective || soapData.objective || soapData.assessment || soapData.plan || icd10Code.value || cptCode.value);
});

// --- Methods ---
async function saveNote() {
  error.value = ''; // Clear previous errors
  if (!props.patient || !props.patient.patient_id) {
    error.value = 'No patient selected. Cannot save note.';
    console.error('Save error: Patient data is missing.');
    return;
  }

  // Optional: Add more robust validation here if needed
  if (!canSave.value) {
     error.value = 'Please fill in at least one field before saving.';
     return;
  }

  isLoading.value = true;

  try {
    // 1. Get Cognito Token
    const { tokens } = await fetchAuthSession();
    const idToken = tokens?.idToken?.toString(); // Use toString() to get the actual token string
    if (!idToken) {
      throw new Error('Authentication token not found.');
    }

    // 2. Prepare API Payload
    const payload = {
      patient_id: props.patient.patient_id,
      subjective: soapData.subjective,
      objective: soapData.objective,
      assessment: soapData.assessment,
      plan: soapData.plan,
      icd10_code: icd10Code.value || null, // Send null if empty
      cpt_code: cptCode.value || null     // Send null if empty
    };

    console.log('Attempting to save SOAP note with payload:', payload);

    // 3. Make API Call
    // IMPORTANT: Replace 'yourApiName' with the actual name defined in main.js amplify config
    const restOperation = post({ 
      apiName: 'emrApi', // Replace with your API name registered with Amplify
      path: '/soapnotes', 
      options: { 
        body: payload, 
        headers: { 
          Authorization: idToken 
        }
      }
    });

    const response = await restOperation.response;
    const responseBody = await response.body.json(); // Assuming the body is JSON

    console.log('API Response Status:', response.statusCode);
    console.log('API Response Body:', responseBody);

    if (response.statusCode >= 200 && response.statusCode < 300) {
        console.log('SOAP note saved successfully!');
        resetForm();
        emit('close-request'); // Signal parent to close the modal/view
    } else {
        // Try to get error message from response body, otherwise use generic message
        const apiError = responseBody?.message || responseBody?.error || `Failed with status code ${response.statusCode}`;
        throw new Error(`API Error: ${apiError}`);
    }

  } catch (err) {
    console.error('Error saving SOAP note:', err);
    // Display a user-friendly error message
    error.value = `Failed to save SOAP note: ${err.message || 'Unknown error'}`;
  } finally {
    isLoading.value = false;
  }
}

function resetForm() {
  soapData.subjective = '';
  soapData.objective = '';
  soapData.assessment = '';
  soapData.plan = '';
  icd10Code.value = '';
  cptCode.value = '';
  error.value = '';
  // isLoading should be reset in the finally block of saveNote
}

</script>

<style scoped>
/* Existing styles might need minor adjustments */
.soap-container {
  display: flex;
  justify-content: center;
  padding: 20px;
  background-color: #f4f7f9; /* Light neutral background */
  position: fixed; /* Make it float */
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  overflow-y: auto; /* Allow scrolling if content overflows */
  z-index: 999; /* Ensure it's above other content but below modals if needed */
  box-sizing: border-box; /* Include padding in width/height */
}

.soap-content {
  background-color: #ffffff; /* White background for the content area */
  padding: 25px 35px;
  border-radius: 8px;
  box-shadow: 0 4px 15px rgba(0, 0, 0, 0.1);
  width: 100%;
  max-width: 900px; /* Limit maximum width */
  margin: 20px auto; /* Center horizontally with some margin */
  display: flex;
  flex-direction: column;
  height: fit-content; /* Adjust height based on content */
}


h2 {
  font-size: 1.4rem; /* Slightly larger */
  font-weight: 600;
  margin-bottom: 1.5rem;
  color: #333;
  border-bottom: 2px solid #3b6ce7; /* Blue accent line */
  padding-bottom: 0.5rem;
  text-align: center; /* Center the title */
}

h3 {
  font-size: 1.1rem; /* Adjusted size */
  font-weight: 600;
  margin-bottom: 1rem;
  color: #333;
  /* Removed background color for cleaner look */
  border-bottom: 1px solid #dee2e6;
  padding-bottom: 8px;
  margin-top: 1.5rem; /* Add space above coding section */
}

.soap-form {
  display: flex;
  flex-direction: column;
  gap: 1rem; /* Reduced gap */
  margin-bottom: 1.5rem;
  /* Removed background color and padding for cleaner look */
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px; /* Reduced gap */
  padding: 10px; /* Reduced padding */
  border-radius: 6px;
  border: 1px solid #dee2e6; /* Lighter border */
  /* Keep background colors for distinction */
}

.subjective {
  background-color: rgba(248, 229, 229, 0.5); /* Lighter shade */
}

.objective {
  background-color: rgba(229, 238, 255, 0.5); /* Lighter shade */
}

.assessment {
  background-color: rgba(231, 229, 248, 0.5); /* Lighter shade */
}

.plan {
  background-color: rgba(229, 248, 237, 0.5); /* Lighter shade */
}

label {
  font-size: 0.9rem; /* Slightly larger */
  font-weight: 500; /* Medium weight */
  color: #495057; /* Darker grey */
}

.soap-textarea {
  width: 100%;
  padding: 10px;
  border: 1px solid #ced4da;
  border-radius: 4px;
  font-size: 0.9rem;
  line-height: 1.5;
  resize: vertical;
  min-height: 80px; /* Slightly shorter */
  background-color: #ffffff;
  color: #333;
  box-sizing: border-box;
}

.soap-textarea:focus {
  outline: none;
  border-color: #80bdff;
  box-shadow: 0 0 0 0.2rem rgba(0, 123, 255, 0.25);
}

/* Simplified Medical Coding Section */
.coding-section {
  margin-bottom: 1.5rem;
  /* Removed background color and padding */
}

.coding-inputs {
    background-color: #f8f9fa; /* Light grey background for coding inputs */
    margin-bottom: 1rem;
    border: 1px solid #dee2e6 !important; /* Override form-group border if needed */
}

.code-input {
    padding: 10px;
    border: 1px solid #ced4da;
    border-radius: 4px;
    font-size: 0.9rem;
    width: 100%;
    box-sizing: border-box;
}

.code-input:focus {
    outline: none;
    border-color: #80bdff;
    box-shadow: 0 0 0 0.2rem rgba(0, 123, 255, 0.25);
}

/* Action Buttons */
.action-buttons {
  display: flex;
  justify-content: flex-end; /* Align button to the right */
  gap: 1rem;
  margin-top: 1.5rem; /* Add space above buttons */
  padding-top: 1.5rem;
  border-top: 1px solid #dee2e6; /* Separator line */
  /* Removed background color */
}

.save-draft-button { /* Renamed class to save-note-button if preferred */
  padding: 10px 25px;
  background-color: #28a745; /* Green for save */
  border: none;
  color: white;
  border-radius: 5px;
  font-size: 0.95rem;
  font-weight: 500;
  cursor: pointer;
  /* flex: 1; */ /* Don't make it full width */
  transition: all 0.2s;
}

.save-draft-button:hover:not(:disabled) {
  background-color: #218838;
  box-shadow: 0 2px 5px rgba(0,0,0,0.15);
}

.save-draft-button:disabled {
  background-color: #cccccc;
  cursor: not-allowed;
}

/* Error Message Style */
.error-message {
  color: #dc3545;
  background-color: #f8d7da;
  border: 1px solid #f5c6cb;
  padding: 10px 15px;
  border-radius: 4px;
  margin-bottom: 15px;
  text-align: center;
  font-size: 0.9rem;
}

</style>



