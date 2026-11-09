// Coffee Please settings. Fill these in from the deploy guide (README.md, steps 3 and 5).
// None of these values are secret: they identify your Firebase project and your public alert key.

export const firebaseConfig = {// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyCL2I6VxthKJqMvfHpzXsCSHOpHJss7bII",
  authDomain: "coffee-please-1b878.firebaseapp.com",
  projectId: "coffee-please-1b878",
  storageBucket: "coffee-please-1b878.firebasestorage.app",
  messagingSenderId: "670817085215",
  appId: "1:670817085215:web:231cc7d1f4886d9d87722a"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
};

// The PUBLIC half of the alert key pair (from `npx web-push generate-vapid-keys`).
export const VAPID_PUBLIC_KEY = "PASTE_VAPID_PUBLIC_KEY";

// Must match the region in functions/index.js and your Firestore location.
export const FUNCTIONS_REGION = "australia-southeast1";
