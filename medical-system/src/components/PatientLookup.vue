<template>
  <div class="patient-lookup-container">
    <h2>Patient Lookup (Test V3)</h2> 
    <div v-if="errorMessage" class="error-message">{{ errorMessage }}</div>
    <div v-if="successMessage" class="success-message">{{ successMessage }}</div>

    <form @submit.prevent="searchPatients">
      <div class="form-row">
        <div class="form-group">
          <label for="firstName">First Name:</label>
          <input type="text" id="firstName" v-model="searchCriteria.firstName">
        </div>
        <div class="form-group">
          <label for="lastName">Last Name:</label>
          <input type="text" id="lastName" v-model="searchCriteria.lastName">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="dob">Date of Birth:</label>
          <input type="date" id="dob" v-model="searchCriteria.dateOfBirth">
        </div>
        <div class="form-group">
          <label for="phone">Phone Number:</label>
          <input type="tel" id="phone" v-model="searchCriteria.phoneNumber">
        </div>
      </div>
      <button type="submit" :disabled="isLoading">
        {{ isLoading ? 'Searching...' : 'Search Patients' }}
      </button>
       <button type="button" @click="$emit('close')">Cancel</button>
    </form>

    <div v-if="searchResults.length > 0" class="search-results">
      <h3>Search Results</h3>
      <table>
        <thead>
          <tr>
            <th>First Name</th>
            <th>Last Name</th>
            <th>DOB</th>
            <th>Phone</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="patient in searchResults" :key="patient.patient_id">
            <td>{{ patient.first_name }}</td>
            <td>{{ patient.last_name }}</td>
            <td>{{ patient.date_of_birth }}</td>
            <td>{{ patient.phone_number }}</td>
            <td>
              <button @click="addToQueue(patient.patient_id)" :disabled="isAddingToQueue === patient.patient_id">
                {{ isAddingToQueue === patient.patient_id ? 'Adding...' : 'Add to Queue' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
     <div v-else-if="searched && !isLoading">
        <p>No patients found matching your criteria.</p>
    </div> 
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue';
import { get } from '@aws-amplify/api'; // <-- ADD THIS for v6+
import { fetchAuthSession } from '@aws-amplify/auth';

console.log('[PatientLookup] Script Setup block loading - V3'); 

const emit = defineEmits(['close']); // To close the component

const searchCriteria = reactive({
  firstName: '',
  lastName: '',
  dateOfBirth: '',
  phoneNumber: ''
});

const searchResults = ref([]);
const isLoading = ref(false);
const isAddingToQueue = ref(null); // Store patient_id being added
const errorMessage = ref('');
const successMessage = ref('');
const searched = ref(false); // Track if a search has been performed

const searchPatients = async () => {
  console.log('[PatientLookup] Entering searchPatients function - V3');
  isLoading.value = true;
  searched.value = true;
  errorMessage.value = '';
  successMessage.value = '';
  searchResults.value = [];

  // Construct query parameters, only including non-empty values
  const queryParams = {};
  if (searchCriteria.firstName) queryParams.firstName = searchCriteria.firstName;
  if (searchCriteria.lastName) queryParams.lastName = searchCriteria.lastName;
  if (searchCriteria.dateOfBirth) queryParams.dateOfBirth = searchCriteria.dateOfBirth;
  if (searchCriteria.phoneNumber) queryParams.phoneNumber = searchCriteria.phoneNumber;

  // Basic validation: ensure at least one criterion is provided
  if (Object.keys(queryParams).length === 0) {
      errorMessage.value = 'Please provide at least one search criterion.';
      isLoading.value = false;
      return;
  }

  let idToken = '';
  try {
    const { tokens } = await fetchAuthSession();
    if (!tokens?.idToken) {
        throw new Error('No ID token found in session.');
    }
    idToken = tokens.idToken.toString();
  } catch (authError) {
      console.error('Authentication error:', authError);
      errorMessage.value = 'Authentication error retrieving token.';
      isLoading.value = false;
      return;
  }


  try {
    const apiName = 'emrApi'; // Defined in main.js or similar
    const path = '/'; // Ensure this is the correct endpoint
    // Note: For v6 'get', query parameters go inside 'options'
    const options = {
      queryParams: queryParams,
      headers: {
        Authorization: idToken // Explicitly adding Authorization header
      }
    };

    console.log('[PatientLookup] Calling API.get with options - V3:', options);
    // Use the imported 'get' function with the v6+ syntax
    const restOperation = get({ apiName, path, options });
    const response = await restOperation.response;
    console.log('[PatientLookup] Raw API response received - V3:', response);

    const data = await response.body.json(); // Assuming response body is JSON
    console.log('[PatientLookup] Parsed response body (data) - V3:', data);

    // IMPORTANT: Adjust this based on your actual API response structure
    // If your API returns the array directly, use: searchResults.value = data;
    // If it returns { patients: [...] }, use: searchResults.value = data.patients || [];
    // For now, let's assume it returns the array directly based on previous attempts.
    searchResults.value = data || []; // Assign the parsed data

    console.log('[PatientLookup] searchResults.value after assignment - V3:', searchResults.value);
    console.log('[PatientLookup] searchResults.value.length after assignment - V3:', searchResults.value?.length);

  } catch (error) {
    console.error('Error searching patients - V3:', error);
    // Attempt to parse error response body if available
    let errorBody = '';
    if (error.response && typeof error.response.body.json === 'function') {
        try {
            errorBody = await error.response.body.json();
            console.error('API Error Response Body - V3:', errorBody);
        } catch (parseError) {
            console.error('Failed to parse error response body - V3:', parseError);
        }
    }
    errorMessage.value = `Error searching patients: ${errorBody?.message || error.message || 'Unknown error'}`;
  } finally {
    isLoading.value = false;
  }
};

const addToQueue = async (patientId) => {
  isAddingToQueue.value = patientId; // Indicate loading state for this specific button
  errorMessage.value = '';
  successMessage.value = '';

  let idToken = '';
  try {
    const { tokens } = await fetchAuthSession();
    if (!tokens?.idToken) {
      throw new Error('No ID token found in session.');
    }
    idToken = tokens.idToken.toString();
  } catch (authError) {
    console.error('Authentication error:', authError);
    errorMessage.value = 'Authentication error. Please sign out and sign back in.';
    isAddingToQueue.value = null; // Reset loading state
    return;
  }

  try {
    const apiName = 'emrApi';
    const path = '/queue';

    // Prepare options for the POST request
    const options = {
      body: { patientId: patientId },
      headers: { 
        Authorization: idToken // Explicitly add the ID token
      }
    };

    console.log('Posting to /queue with options:', options);
    const response = await API.post(apiName, path, options);
    console.log('Add to queue response:', response);
    successMessage.value = response.message || 'Patient added to queue successfully!';

  } catch (error) {
    console.error('Error adding patient to queue:', error);
    // Check if the error has a response object and data for more details
    const errorDetail = error.response?.data?.message || error.message || 'Unknown error';
    errorMessage.value = `Error adding to queue: ${errorDetail}`;
  } finally {
    isAddingToQueue.value = null; // Reset loading state
  }
};
</script>

<style scoped>
.patient-lookup-container {
  padding: 20px;
  border: 1px solid #ccc;
  border-radius: 8px;
  margin-top: 20px;
  background-color: #f9f9f9;
}

h2, h3 {
  color: #333;
  margin-bottom: 15px;
}

form {
  display: flex;
  flex-direction: column;
  gap: 15px;
  margin-bottom: 20px;
}

.form-row {
    display: flex;
    gap: 15px; 
}

.form-group {
  display: flex;
  flex-direction: column;
  flex: 1; 
}

label {
  margin-bottom: 5px;
  font-weight: bold;
  color: #555;
}

input[type="text"],
input[type="date"],
input[type="tel"] {
  padding: 10px;
  border: 1px solid #ccc;
  border-radius: 4px;
  font-size: 1rem;
}

button {
  padding: 10px 15px;
  background-color: #007bff;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 1rem;
  transition: background-color 0.3s ease;
  margin-right: 10px; 
}

button[type="button"] {
  background-color: #6c757d; 
}


button:disabled {
  background-color: #ccc;
  cursor: not-allowed;
}

button:not(:disabled):hover {
  background-color: #0056b3;
}

button[type="button"]:not(:disabled):hover {
    background-color: #5a6268;
}

.search-results {
  margin-top: 20px;
}

table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 10px;
}

th, td {
  border: 1px solid #ddd;
  padding: 10px;
  text-align: left;
}

th {
  background-color: #f2f2f2;
  font-weight: bold;
}

.error-message {
  color: #dc3545;
  background-color: #f8d7da;
  border: 1px solid #f5c6cb;
  padding: 10px;
  border-radius: 4px;
  margin-bottom: 15px;
}

.success-message {
  color: #155724;
  background-color: #d4edda;
  border: 1px solid #c3e6cb;
  padding: 10px;
  border-radius: 4px;
  margin-bottom: 15px;
} 
</style>
