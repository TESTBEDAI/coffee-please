# Coffee Please

Tap one button at the café and everyone on your team gets an alert on their phone, even with the app closed. They say yes or no, pick a saved order, and it lands on your order docket. The app counts who has shouted how many coffees. No money changes hands in the app.

- **The app** is a web page served free from GitHub Pages (the `docs/` folder).
- **Firebase** (Google) stores the team's data and sends the alerts (the `functions/` folder and `firestore.rules`).

Setup takes about 45 minutes, all in a web browser. You need your GitHub account, your Google account, and a card for Firebase's pay-as-you-go plan. At team scale, the free quotas mean the bill should be $0.

---

## 1. Put the code on GitHub and switch on Pages

1. Go to <https://github.com/new>. Name the repository **coffee-please**, choose **Public**, and click **Create repository**. (Free GitHub Pages needs a public repository. Nothing in this code is secret.)
2. On the new repository page, click **uploading an existing file**. Drag in everything from the unzipped `coffee-please` folder: `docs`, `functions`, `tools`, `firebase.json`, `firestore.rules`, `firestore.indexes.json` and `README.md`. Click **Commit changes**.
3. Go to **Settings → Pages**. Under **Build and deployment**, set **Source** to **Deploy from a branch**, branch **main**, folder **/docs**, then **Save**.
4. After a minute the page shows your site address: `https://YOUR-GITHUB-NAME.github.io/coffee-please/`. Opening it now shows "Almost there". That's expected until step 3 is done.

## 2. Create the Firebase project

1. Go to <https://console.firebase.google.com>, signed in with your Google account. Click **Create a project** and name it `coffee-please`. Turn Google Analytics **off**. Note the **Project ID** it shows (for example `coffee-please-1a2b3`).
2. Bottom left, click **Upgrade** and choose the **Blaze (pay as you go)** plan. Add your card. When asked, set a **budget alert**, for example $5. (The alert function needs this plan. A team's usage stays inside the free quotas.)
3. Left menu: **Build → Firestore Database → Create database**. Choose **Standard edition** if asked, **Production mode**, and location **australia-southeast1 (Sydney)**. The location can't be changed later, and the code expects Sydney.

## 3. Connect the app to Firebase

1. In Firebase, click the gear icon → **Project settings**. Under **Your apps**, click the web icon **`</>`**. Nickname it `Coffee Please`, leave Hosting unticked, and click **Register app**.
2. Firebase shows a `firebaseConfig` block. On GitHub, open `docs/config.js`, click the pencil icon to edit, and copy in the four values: `apiKey`, `authDomain`, `projectId` and `appId`. Leave `VAPID_PUBLIC_KEY` for step 5. Click **Commit changes**.

## 4. Switch on email sign-in

1. In Firebase: **Build → Authentication → Get started → Sign-in method → Email/Password**.
2. Turn on **Email/Password** and **Email link (passwordless sign-in)**. Click **Save**.
3. Go to the **Settings** tab → **Authorized domains → Add domain**, and add `YOUR-GITHUB-NAME.github.io` (no `https://`, no `/coffee-please`).

## 5. Make the alert keys

Alerts are signed with a key pair. The public half goes in the app. The private half stays in Firebase.

1. Open Google Cloud Shell at <https://shell.cloud.google.com>, signed in with the same Google account. It's a free command line in your browser. Paste each command below and press Enter.
2. Get your code and make the keys (replace `YOUR-GITHUB-NAME`):
   ```
   git clone https://github.com/YOUR-GITHUB-NAME/coffee-please.git
   cd coffee-please
   npx --yes web-push@3.6.7 generate-vapid-keys
   ```
   It prints a **Public Key** and a **Private Key**. Keep this window open.
3. On GitHub, edit `docs/config.js` again. Paste the **Public Key** into `VAPID_PUBLIC_KEY` and commit.
4. Back in Cloud Shell, save the public key and your email for the backend (replace both values):
   ```
   printf 'VAPID_PUBLIC_KEY=PASTE_PUBLIC_KEY\nVAPID_SUBJECT=mailto:you@example.com\n' > functions/.env
   ```

## 6. Deploy the backend

Still in Cloud Shell, inside the `coffee-please` folder. Replace `YOUR-PROJECT-ID` with the Project ID from step 2.

```
export PROJECT=YOUR-PROJECT-ID
npx --yes firebase-tools@15.35.0 login --no-localhost
```
Follow the link it shows, sign in, and paste the code back into Cloud Shell. Then:

```
(cd functions && npm install)
npx firebase-tools@15.35.0 functions:secrets:set VAPID_PRIVATE_KEY --project $PROJECT
```
Paste the **Private Key** when it asks. Then deploy:

```
npx firebase-tools@15.35.0 deploy --only firestore,functions --project $PROJECT
```

- The first deploy takes about 5 minutes and switches on some Google services. Answer **Yes** if it asks to enable an API.
- If it asks about a **cleanup policy** for container images, answer **Yes** and accept the default.
- If the first deploy fails with a permissions or "Eventarc" error, wait 5 minutes and run the same deploy command again. Google sets up permissions in the background the first time.

When it finishes it lists four functions: `runStarted`, `answerChanged`, `closingReminders` and `sendTestAlert`.

## 7. Start your team

**On your iPhone** (iOS 16.4 or later):
1. Open your site in **Safari**. It shows how to add it: tap **Share**, then **Add to Home Screen**, then **Add**.
2. Open **Coffee** from your Home Screen. Enter your email and tap **Email me a sign-in link**.
3. In the email, **press and hold** the sign-in link, tap **Copy Link**, go back to Coffee and paste it. (If you tap the link instead, it opens Safari. Safari then offers a **Copy sign-in link** button for the same thing.)
4. You're the first person in, so you'll **Create the team**.
5. On the **Me** tab, tap **Turn on alerts**, then **Allow**. Tap **Send a test alert** and lock your phone. It should arrive within a few seconds.
6. Tap **Copy invite link** and send it to your team.

**On Android:** open the site in Chrome, tap the menu, then **Add to Home screen** or **Install app**. Sign in by tapping the link in the email. Then do steps 4 to 6 above.

**Your team** opens the invite link and follows the same steps. Instead of creating the team, they enter their name and join. The invite code is already filled in from the link.

---

## How it behaves

- **Starting a run** alerts everyone you ticked. About 2 minutes before the window closes, people who haven't answered get a last-call alert.
- **As people answer**, you get an alert (each person can turn this off on the Me tab).
- **Recording** the run counts one shout for you and one coffee had for everyone else who said yes. Your own coffee isn't counted as a shout.
- **Forgotten runs** are recorded automatically after 3 hours, using the yes answers.
- **The tally** shows shouts, coffees bought for others, coffees had and the balance. The person with the lowest balance is next to shout.
- **As owner** you can remove people, make a new invite link (old links stop working), and delete a run from History.

## Changing things later

- **The app (`docs/`)**: edit on GitHub. The site updates within about a minute. If phones keep showing the old version, raise the `?v=1` numbers in `docs/index.html` and `docs/app.js` to `?v=2`.
- **The backend (`functions/`, `firestore.rules`)**: commit on GitHub, then in Cloud Shell run `cd coffee-please && git pull` and the deploy command from step 6.

## If something isn't working

| Problem | Fix |
| --- | --- |
| "This site isn't on Firebase's list of allowed domains" | Do step 4.3. |
| Sign-in link says it expired | Links work once and expire. Send a new one. |
| No alerts on iPhone | Open Coffee from the Home Screen, not Safari. Check Settings → Notifications → Coffee. A Focus mode can hide alerts. |
| Test alert says it couldn't be delivered | Delete the Home Screen icon, add it again, sign in and turn alerts back on. |
| Alerts are slow on Android | Settings → Apps → Chrome → Battery → Unrestricted. |
| Anything else | Firebase console → **Functions → Logs** shows each alert sent and any errors. |

## What's in this folder

| Path | What it is |
| --- | --- |
| `docs/` | The app GitHub Pages serves: `index.html`, `app.js`, `styles.css`, `sw.js` (shows alerts), `manifest.webmanifest`, icons, and `config.js` (your settings). |
| `docs/vendor/firebase.js` | Google's Firebase web library (version 13.1.0), bundled so the app doesn't depend on another website. Rebuild with `tools/` if you ever need to. |
| `functions/index.js` | The backend: sends alerts for new runs, answers, last calls and the test button. |
| `firestore.rules` | Who can read and change what. Only people who joined with the current invite code can see anything. Each person can only change their own entries. |

**Privacy and safety:** the values in `config.js` aren't secret. They identify your project, and the rules protect the data. The private alert key lives only in Firebase Secret Manager. The invite link is the key to join, so make a new one if it's shared too widely.
