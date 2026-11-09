// Coffee Please — Firebase backend. Sends alerts to phones, including when the app is closed.
const { onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret, defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const webpush = require("web-push");

// Keep this the same as your Firestore location and FUNCTIONS_REGION in docs/config.js.
const REGION = "australia-southeast1";
setGlobalOptions({ region: REGION, maxInstances: 3 });

const VAPID_PUBLIC_KEY = defineString("VAPID_PUBLIC_KEY");
const VAPID_SUBJECT = defineString("VAPID_SUBJECT");
const VAPID_PRIVATE_KEY = defineSecret("VAPID_PRIVATE_KEY");

initializeApp();
const db = getFirestore();

const STALE_MS = 3 * 3600e3;
const REMIND_BEFORE_MS = 2 * 60e3;

function orderText(o) {
  if (!o || typeof o !== "object") return "No order";
  const drink = o.drink === "Other" ? (o.other || "Something else") : (o.drink || "Coffee");
  const parts = [(o.size ? o.size + " " : "") + String(drink).toLowerCase()];
  if (o.milk && o.milk !== "Full cream") parts.push(String(o.milk).toLowerCase());
  if (o.strength && o.strength !== "Normal") parts.push(String(o.strength).toLowerCase());
  if (o.sugar) parts.push(o.sugar + (o.sugar === 1 ? " sugar" : " sugars"));
  if (o.hot) parts.push("extra hot");
  if (o.notes) parts.push(o.notes);
  const s = parts.join(", ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function nameOf(uid) {
  const snap = await db.doc(`members/${uid}`).get();
  return (snap.exists && snap.data().name) || "Someone";
}

let configured = false;
function configure() {
  if (configured) return;
  webpush.setVapidDetails(VAPID_SUBJECT.value(), VAPID_PUBLIC_KEY.value(), VAPID_PRIVATE_KEY.value());
  configured = true;
}

// Send one alert to every device each person has turned alerts on for. Removes devices that have gone away.
async function sendTo(uids, payload) {
  configure();
  const body = JSON.stringify(payload);
  let sent = 0;
  await Promise.all([...new Set(uids)].map(async (uid) => {
    const ref = db.doc(`pushSubs/${uid}`);
    const snap = await ref.get();
    const subs = snap.exists && Array.isArray(snap.data().subs) ? snap.data().subs : [];
    if (!subs.length) return;
    const dead = [];
    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, { TTL: 30 * 60, urgency: "high" });
        sent++;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) dead.push(s.endpoint);
        else logger.warn("Alert failed", { uid, status: e.statusCode, body: e.body });
      }
    }));
    if (dead.length) {
      await db.runTransaction(async (tx) => {
        const fresh = await tx.get(ref);
        if (!fresh.exists) return;
        const keep = (fresh.data().subs || []).filter((s) => !dead.includes(s.endpoint));
        tx.update(ref, { subs: keep });
      });
    }
  }));
  return sent;
}

// 1. Someone starts a run: alert everyone they asked.
exports.runStarted = onDocumentCreated({ document: "runs/{runId}", secrets: [VAPID_PRIVATE_KEY] }, async (event) => {
  const run = event.data && event.data.data();
  if (!run || run.status !== "open") return;
  const runId = event.params.runId;
  const buyer = await nameOf(run.by);
  const mins = Math.max(1, Math.round((run.closesAt - Date.now()) / 60000));
  const to = (run.invited || []).filter((u) => u !== run.by);
  const sent = await sendTo(to, {
    title: `☕ ${buyer} is at ${run.cafe || "the café"}`,
    body: `Want a coffee? Tap to answer. ${mins} min to order.`,
    url: `./#run=${runId}`,
    tag: `run-${runId}`,
  });
  logger.info("Run alerts sent", { runId, people: to.length, devices: sent });
});

// 2. Someone answers: alert the person buying (unless they've turned that off).
exports.answerChanged = onDocumentWritten({ document: "runs/{runId}/answers/{uid}", secrets: [VAPID_PRIVATE_KEY] }, async (event) => {
  const after = event.data && event.data.after && event.data.after.data();
  if (!after) return;
  const before = event.data.before && event.data.before.data();
  if (before && before.answer === after.answer && JSON.stringify(before.order) === JSON.stringify(after.order)) return;
  const { runId, uid } = event.params;
  const runSnap = await db.doc(`runs/${runId}`).get();
  const run = runSnap.exists ? runSnap.data() : null;
  if (!run || run.status !== "open" || run.by === uid) return;
  const buyer = await db.doc(`members/${run.by}`).get();
  if (buyer.exists && buyer.data().notifyAnswers === false) return;
  const who = await nameOf(uid);
  await sendTo([run.by], {
    title: `${who} answered`,
    body: after.answer === "yes" ? `Yes please: ${orderText(after.order)}` : "No thanks",
    url: `./#run=${runId}`,
    tag: `ans-${runId}-${uid}`,
  });
});

// 3. Every minute: remind people who haven't answered, and tidy up runs left open.
exports.closingReminders = onSchedule({ schedule: "every 1 minutes", timeZone: "Australia/Sydney", secrets: [VAPID_PRIVATE_KEY] }, async () => {
  const now = Date.now();
  const open = await db.collection("runs").where("status", "==", "open").get();
  for (const doc of open.docs) {
    const r = doc.data();
    // A run nobody recorded within 3 hours is recorded automatically with the yes answers.
    if (now - (r.createdAt || 0) > STALE_MS) {
      const answers = await doc.ref.collection("answers").get();
      const orders = answers.docs.filter((a) => a.data().answer === "yes").map((a) => ({ uid: a.id, order: a.data().order || null }));
      await doc.ref.update(orders.length
        ? { status: "done", completedAt: now, orders, autoClosed: true }
        : { status: "cancelled", completedAt: now, autoClosed: true });
      continue;
    }
    if (r.reminded || r.closesAt - now > REMIND_BEFORE_MS) continue;
    await doc.ref.update({ reminded: true });
    if (r.closesAt < now - 60e3) continue;
    const answered = new Set((await doc.ref.collection("answers").get()).docs.map((a) => a.id));
    const to = (r.invited || []).filter((u) => u !== r.by && !answered.has(u));
    if (!to.length) continue;
    const buyer = await nameOf(r.by);
    await sendTo(to, {
      title: `⏱ Last call from ${buyer}`,
      body: `About 2 minutes left to order from ${r.cafe || "the café"}.`,
      url: `./#run=${doc.id}`,
      tag: `run-${doc.id}`,
    });
  }
});

// 4. "Send a test alert" button in the app.
exports.sendTestAlert = onCall({ secrets: [VAPID_PRIVATE_KEY] }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const member = await db.doc(`members/${req.auth.uid}`).get();
  if (!member.exists) throw new HttpsError("permission-denied", "Join the team first.");
  const snap = await db.doc(`pushSubs/${req.auth.uid}`).get();
  const n = snap.exists ? (snap.data().subs || []).length : 0;
  if (!n) throw new HttpsError("failed-precondition", "Alerts aren't turned on for any of your devices yet.");
  const sent = await sendTo([req.auth.uid], { title: "☕ Test alert", body: "Alerts are working on this device.", url: "./", tag: "test" });
  if (!sent) throw new HttpsError("unavailable", "The alert couldn't be delivered. Turn alerts off and on again on this device.");
  return { devices: sent };
});
