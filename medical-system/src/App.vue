<script setup>
import { Authenticator } from "@aws-amplify/ui-vue";
import "@aws-amplify/ui-vue/styles.css";
import { ref } from 'vue';
import { del } from '@aws-amplify/api'; 
import { fetchAuthSession } from '@aws-amplify/auth'; 
import SOAPNoteCreator from './components/SOAPNoteCreator.vue';

const showSOAPNoteCreator = ref(false);
const currentPatientForNote = ref(null);

const emit = defineEmits(['refresh-queue-list']);

function handleStartSOAPNote(patient) {
  console.log('App.vue: Received start-soap-note event for patient:', patient);
  currentPatientForNote.value = patient;
  showSOAPNoteCreator.value = true;
}

async function closeSOAPNoteCreator() {
  const patientToRemove = currentPatientForNote.value; 
  
  showSOAPNoteCreator.value = false;
  currentPatientForNote.value = null; 

  if (patientToRemove && patientToRemove.queue_entry_id) {
    const queueEntryId = patientToRemove.queue_entry_id;
    console.log(`Attempting to remove patient with queue_entry_id: ${queueEntryId} from queue.`);
    try {
      const session = await fetchAuthSession();
      const idToken = session.tokens?.idToken?.toString();
      if (!idToken) {
        throw new Error("Authentication token not found.");
      }

      const apiName = 'emrApi'; 
      const path = `/queue/${queueEntryId}`;
      const requestOptions = {
        headers: {
          Authorization: idToken
        }
      };

      await del({
        apiName: apiName,
        path: path,
        options: requestOptions
      });
      console.log(`Successfully removed patient ${queueEntryId} from queue via API.`);
      
      emit('refresh-queue-list');
      console.log('Emitted refresh-queue-list event.');

    } catch (error) {
      console.error(`Error removing patient ${queueEntryId} from queue:`, error);
    }
  }
}
</script>

<template>
  <authenticator>
    <template v-slot="{ user, signOut }">
      <header class="app-header">
        <h1>Welcome, {{ user?.signInDetails?.loginId || 'User' }}!</h1>
        <button @click="signOut" class="sign-out-button">Sign Out</button>
      </header>

      <router-view @start-soap-note="handleStartSOAPNote" @refresh-queue-list="emit('refresh-queue-list')" />

      <SOAPNoteCreator 
        v-if="showSOAPNoteCreator" 
        :patient="currentPatientForNote"
        @close-request="closeSOAPNoteCreator"
      />

      <button 
        v-if="showSOAPNoteCreator" 
        @click="closeSOAPNoteCreator" 
        class="toggle-soap-note-creator close-button"
      >
        Close Note
      </button>
    </template>
  </authenticator>
</template>

<style scoped>
.app-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1em 2em;
  background-color: #f0f0f0;
  border-bottom: 1px solid #ccc;
}

h1 {
  margin: 0;
  color: #2c3e50;
}

.sign-out-button {
  padding: 0.5em 1em;
  font-size: 0.9em;
  cursor: pointer;
  border: none;
  border-radius: 4px;
  background-color: #e74c3c;
  color: white;
  transition: background-color 0.3s ease;
}

.sign-out-button:hover {
  background-color: #c0392b;
}

.toggle-soap-note-creator {
  position: fixed;
  bottom: 20px;
  right: 20px;
  padding: 10px 20px;
  background: #007bff;
  color: white;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  z-index: 1000;
}

.close-button {
  background-color: #6c757d;
}

.close-button:hover {
  background-color: #5a6268;
}
</style>

<style>
.app-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 1.5rem;
  background-color: #f8f9fa;
  border-bottom: 1px solid #dee2e6;
  margin-bottom: 1rem;
}

.app-header h1 {
  font-size: 1.2rem;
  margin: 0;
  color: #343a40;
}

.sign-out-button {
  padding: 0.5rem 1rem;
  font-size: 0.9rem;
  color: #fff;
  background-color: #6c757d;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.sign-out-button:hover {
  background-color: #5a6268;
}

.toggle-soap-note-creator {
  position: fixed;
  bottom: 20px;
  right: 20px;
  padding: 10px 20px;
  background: #007bff;
  color: white;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  z-index: 1000;
}

#app {
  font-family: Avenir, Helvetica, Arial, sans-serif;
  text-align: center;
  color: #2c3e50;
}
</style>
