<template>
  <div class="new-patient-form">
    <h3>Create New Patient</h3>
    <form @submit.prevent="handleSubmit">
      <div class="form-grid">
        <div class="form-group">
          <label for="firstName">First Name *</label>
          <input type="text" id="firstName" v-model="patient.firstName" required />
        </div>
        <div class="form-group">
          <label for="lastName">Last Name *</label>
          <input type="text" id="lastName" v-model="patient.lastName" required />
        </div>
        <div class="form-group">
          <label for="middleInitial">Middle Initial</label>
          <input type="text" id="middleInitial" v-model="patient.middleInitial" maxlength="1" />
        </div>
        <div class="form-group">
          <label for="preferredName">Preferred Name</label>
          <input type="text" id="preferredName" v-model="patient.preferredName" />
        </div>
        <div class="form-group">
          <label for="dob">Date of Birth *</label>
          <input type="date" id="dob" v-model="patient.dateOfBirth" required />
        </div>
        <div class="form-group">
          <label for="phone">Phone Number *</label>
          <input type="tel" id="phone" v-model="patient.phoneNumber" required />
        </div>
         <div class="form-group">
          <label for="secondaryPhone">Secondary Phone</label>
          <input type="tel" id="secondaryPhone" v-model="patient.secondaryPhoneNumber" />
        </div>
        <div class="form-group">
          <label for="email">Email</label>
          <input type="email" id="email" v-model="patient.email" />
        </div>
        <div class="form-group">
          <label for="occupation">Occupation</label>
          <input type="text" id="occupation" v-model="patient.occupation" />
        </div>
         <div class="form-group form-group-checkbox">
          <label for="medicareEligible">Medicare Eligible? *</label>
          <input type="checkbox" id="medicareEligible" v-model="patient.isMedicareEligible" />
        </div>
         <div class="form-group form-group-full-width">
          <label for="address">Address</label>
          <textarea id="address" v-model="patient.address"></textarea>
        </div>
      </div>

      <div class="form-actions">
         <button type="submit" :disabled="isSubmitting">{{ isSubmitting ? 'Saving...' : 'Save Patient' }}</button>
         <button type="button" @click="cancelForm" :disabled="isSubmitting">Cancel</button>
      </div>
       <p v-if="errorMessage" class="error-message">{{ errorMessage }}</p>
       <p v-if="successMessage" class="success-message">{{ successMessage }}</p>
    </form>
  </div>
</template>

<script setup>
import { ref } from 'vue';
// Import Amplify Auth functions
import { fetchAuthSession } from 'aws-amplify/auth';

// Define emits to communicate back to the parent (HomePage)
const emit = defineEmits(['formSubmitted', 'formCancelled']);

const patient = ref({
  firstName: '',
  lastName: '',
  middleInitial: '',
  preferredName: '',
  dateOfBirth: '',
  phoneNumber: '',
  secondaryPhoneNumber: '',
  address: '',
  isMedicareEligible: false,
  occupation: '',
  email: '',
});

const isSubmitting = ref(false);
const errorMessage = ref('');
const successMessage = ref('');

const handleSubmit = async () => {
  isSubmitting.value = true;
  errorMessage.value = '';
  successMessage.value = '';

  console.log('Submitting patient data:', patient.value);

  // --- API Call Implementation ---
  try {
    // 1. Get Cognito ID Token
    const { tokens } = await fetchAuthSession({ forceRefresh: false }); // Get current session tokens
    if (!tokens?.idToken) {
      throw new Error('Authentication error: ID Token not found.');
    }
    const idToken = tokens.idToken.toString(); // Get the JWT string
    // console.log('ID Token:', idToken);

    // 2. Make POST request to API Gateway
    const apiInvokeUrl = 'https://12841c6chl.execute-api.us-east-1.amazonaws.com/dev'; // From Terraform output/memory
    const endpoint = `${apiInvokeUrl}/patients`;

    // Map frontend camelCase to backend snake_case
    const patientDataSnakeCase = {
      first_name: patient.value.firstName,
      last_name: patient.value.lastName,
      middle_initial: patient.value.middleInitial,
      preferred_name: patient.value.preferredName,
      date_of_birth: patient.value.dateOfBirth,
      phone_number: patient.value.phoneNumber,
      secondary_phone_number: patient.value.secondaryPhoneNumber,
      email: patient.value.email,
      address: patient.value.address,
      is_medicare_eligible: patient.value.isMedicareEligible,
      occupation: patient.value.occupation,
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}` // Include the ID Token for Cognito Authorizer
      },
      body: JSON.stringify(patientDataSnakeCase) // Send snake_case data
    });

    const responseBody = await response.json();

    // 3. Handle the response
    if (!response.ok) {
      // If response status is not 2xx, throw an error
      console.error('API Error Response:', responseBody);
      throw new Error(responseBody.message || `HTTP error! status: ${response.status}`);
    }

    console.log('API Success Response:', responseBody);
    successMessage.value = `Patient created successfully! ID: ${responseBody.patientId}`;

    // Notify parent after a short delay
    setTimeout(() => {
      emit('formSubmitted'); 
    }, 2000);

  } catch (error) {
    console.error('Error submitting form:', error);
    errorMessage.value = error.message || 'An unexpected error occurred while saving the patient.';
  } finally {
    isSubmitting.value = false;
  }
  // --- End API Call Implementation ---
};

const cancelForm = () => {
  console.log('Form cancelled');
  emit('formCancelled'); // Notify parent
};

// Optional: Function to reset form fields
// const resetForm = () => {
//   patient.value = {
//     firstName: '', lastName: '', middleInitial: '', preferredName: '',
//     dateOfBirth: '', phoneNumber: '', secondaryPhoneNumber: '', address: '',
//     isMedicareEligible: false, occupation: '', email: ''
//   };
//   errorMessage.value = '';
//   successMessage.value = '';
// };

</script>

<style scoped>
.new-patient-form {
  max-width: 800px;
  margin: 2em auto;
  padding: 2em;
  border: 1px solid #ddd;
  border-radius: 8px;
  background-color: #fff;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

h3 {
  text-align: center;
  margin-bottom: 1.5em;
  color: #333;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 1.5em;
  margin-bottom: 2em;
}

.form-group {
  display: flex;
  flex-direction: column;
}

.form-group label {
  margin-bottom: 0.5em;
  font-weight: bold;
  color: #555;
}

.form-group input[type="text"],
.form-group input[type="date"],
.form-group input[type="tel"],
.form-group input[type="email"],
.form-group textarea {
  padding: 0.8em;
  border: 1px solid #ccc;
  border-radius: 4px;
  font-size: 1em;
}

.form-group textarea {
  min-height: 80px;
  resize: vertical;
}

.form-group-checkbox {
  flex-direction: row;
  align-items: center;
  gap: 0.5em;
}

.form-group-checkbox label {
  margin-bottom: 0; /* Adjust alignment */
}

.form-group-checkbox input[type="checkbox"] {
  width: 1.2em;
  height: 1.2em;
}

.form-group-full-width {
  grid-column: 1 / -1; /* Make address span full width */
}

.form-actions {
  display: flex;
  justify-content: center;
  gap: 1em;
  margin-top: 1em;
}

.form-actions button {
  padding: 0.8em 2em;
  font-size: 1em;
  cursor: pointer;
  border: none;
  border-radius: 4px;
  transition: background-color 0.3s ease, opacity 0.3s ease;
}

.form-actions button[type="submit"] {
  background-color: #28a745;
  color: white;
}

.form-actions button[type="submit"]:hover {
  background-color: #218838;
}

.form-actions button[type="button"] {
  background-color: #6c757d;
  color: white;
}

.form-actions button[type="button"]:hover {
  background-color: #5a6268;
}

.form-actions button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.error-message {
  color: #dc3545;
  text-align: center;
  margin-top: 1em;
  font-weight: bold;
}

.success-message {
  color: #28a745;
  text-align: center;
  margin-top: 1em;
  font-weight: bold;
}

</style>
