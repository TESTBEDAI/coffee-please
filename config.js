// Coffee Please settings. Fill these in from the deploy guide (README.md, steps 3 and 5).
// None of these values are secret: they identify your Firebase project and your public alert key.

export const firebaseConfig = {
  apiKey: "AIzaSyCL2I6VxthKJqMvfHpzXsCSHOpHJss7bII",
  authDomain: "coffee-please-1b878.firebaseapp.com",
  projectId: "coffee-please-1b878",
  appId: "1:670817085215:web:231cc7d1f4886d9d87722a",
};

// The PUBLIC half of the alert key pair (from `npx web-push generate-vapid-keys`).
export const VAPID_PUBLIC_KEY = "BHC7Bwl5iYiKhdUbGhwvMFzOP72AMIrjV1ZkrlB00Gjym5zpmzk_PzmcMs6RF6anmIpNLkJIv8WB0kX--WftTFY";

// Must match the region in functions/index.js and your Firestore location.
export const FUNCTIONS_REGION = "australia-southeast1";
