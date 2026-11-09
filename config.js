// Coffee Please settings. Fill these in from the deploy guide (README.md, steps 3 and 5).
// None of these values are secret: they identify your Firebase project and your public alert key.

export const firebaseConfig = {
  apiKey: "PASTE_API_KEY",
  authDomain: "PASTE_PROJECT_ID.firebaseapp.com",
  projectId: "PASTE_PROJECT_ID",
  appId: "PASTE_APP_ID",
};

// The PUBLIC half of the alert key pair (from `npx web-push generate-vapid-keys`).
export const VAPID_PUBLIC_KEY = "PASTE_VAPID_PUBLIC_KEY";

// Must match the region in functions/index.js and your Firestore location.
export const FUNCTIONS_REGION = "australia-southeast1";
