import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router';
import './style.css'
import App from './App.vue'
import HomePage from './components/HomePage.vue';
import SOAPNoteCreator from './components/SOAPNoteCreator.vue';

// --- Add Amplify Configuration ---
import { Amplify } from 'aws-amplify';

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: 'us-east-1_7x5kqVSfc',
      userPoolClientId: '2of9vov3k99um76n9m9tr6n91d',
      region: 'us-east-1'
      // You might add other options like oauth configuration here later
    }
  },
  API: {
    REST: {
      emrApi: { 
        endpoint: 'https://12841c6chl.execute-api.us-east-1.amazonaws.com/dev', 
        region: 'us-east-1',
        authorizationConfig: {
          defaultAuthenticationType: 'AMAZON_COGNITO_USER_POOLS'
        } 
      }
      // You can define more APIs here if needed
    }
  }
});
// --- End Amplify Configuration ---

const routes = [
  {
    path: '/',
    name: 'Home',
    component: HomePage
  },
  {
    path: '/SOAP',
    name: 'SOAPNoteCreator',
    component: SOAPNoteCreator
  }
];

const router = createRouter({
  history: createWebHistory(),
  routes
});

const app = createApp(App)
app.use(router);
app.mount('#app')
