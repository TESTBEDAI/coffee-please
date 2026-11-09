// Coffee Please — web app. Runs from GitHub Pages; Firebase stores the team's data and sends alerts.
import { firebaseConfig, VAPID_PUBLIC_KEY, FUNCTIONS_REGION } from "./config.js?v=1";
import {
  initializeApp, getAuth, onAuthStateChanged, sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink, signOut, connectAuthEmulator,
  getFirestore, doc, collection, query, orderBy, limit, onSnapshot, getDoc, setDoc, updateDoc, deleteDoc, writeBatch, connectFirestoreEmulator,
  getFunctions, httpsCallable, connectFunctionsEmulator,
} from "./vendor/firebase.js";

/* ---------- constants ---------- */
const DRINKS = ["Flat white","Latte","Cappuccino","Long black","Espresso","Piccolo","Macchiato","Magic","Mocha","Chai latte","Hot chocolate","Iced latte","Tea","Other"];
const BLACK = new Set(["Long black","Espresso"]);
const SIZES = ["Small","Regular","Large"];
const MILKS = ["Full cream","Skim","Lactose free","Oat","Almond","Soy","No milk"];
const STRENGTHS = ["Normal","Extra shot","Half strength","Decaf"];
const STALE_MS = 3 * 3600e3;
const CUP = '<svg viewBox="0 0 48 48" width="38" height="38" aria-hidden="true"><path d="M9 18h26v10a12 12 0 0 1-12 12h-2A12 12 0 0 1 9 28z" fill="currentColor"/><path d="M35 21h3a5 5 0 0 1 0 10h-3" fill="none" stroke="currentColor" stroke-width="3"/><path d="M17 6c-2 3 2 5 0 8M23 5c-2 3 2 5 0 8M29 6c-2 3 2 5 0 8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

/* ---------- platform ---------- */
const EMU = new URLSearchParams(location.search).has("emulator");
const CONFIGURED = EMU || !String(firebaseConfig.apiKey).startsWith("PASTE");
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const APP_URL = location.origin + location.pathname;

/* ---------- small helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const str = (v, n) => typeof v === "string" ? v.slice(0, n) : "";
const LS = {
  get(k, d){ try{ const v = localStorage.getItem("cp:" + k); return v == null ? d : JSON.parse(v); }catch(e){ return d; } },
  set(k, v){ try{ localStorage.setItem("cp:" + k, JSON.stringify(v)); }catch(e){} },
  del(k){ try{ localStorage.removeItem("cp:" + k); }catch(e){} },
};
const fmtDate = ts => new Date(ts).toLocaleString("en-AU", {weekday:"short", day:"numeric", month:"short", hour:"numeric", minute:"2-digit"});
function until(ts){ const d = ts - Date.now(); if(d <= 0) return "time's up"; return Math.ceil(d / 60000) + " min left"; }
function toast(msg){ const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 3400); }
async function copy(text, ok = "Copied"){ try{ await navigator.clipboard.writeText(text); toast(ok); }catch(e){ toast("Couldn't copy here. Press and hold the text to copy it."); } }
function randomCode(){ const a = new Uint8Array(9); crypto.getRandomValues(a); return Array.from(a, b => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join(""); }
function b64ToU8(b64){ const pad = "=".repeat((4 - b64.length % 4) % 4); const s = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(s, c => c.charCodeAt(0)); }
function errMsg(e){
  const c = e && e.code || "";
  if(c.includes("permission-denied")) return "You don't have access to do that.";
  if(c.includes("unavailable") || c.includes("network")) return "Couldn't reach the server. Check your connection and try again.";
  if(c.includes("invalid-action-code") || c.includes("expired-action-code")) return "That sign-in link has expired or was already used. Send a new one.";
  if(c.includes("invalid-email")) return "That email address doesn't look right.";
  if(c.includes("too-many-requests") || c.includes("quota")) return "Too many tries. Wait a few minutes and try again.";
  if(c.includes("unauthorized-continue-uri") || c.includes("unauthorized-domain")) return "This site isn't on Firebase's list of allowed domains yet (deploy guide, step 4).";
  return (e && e.message) ? e.message.replace(/^Firebase:\s*/, "") : "Something went wrong. Try again.";
}

/* ---------- orders ---------- */
function cleanOrder(o){
  if(!o || typeof o !== "object") return null;
  return { drink:str(o.drink,40) || "Flat white", size:str(o.size,12), milk:str(o.milk,20), strength:str(o.strength,20),
    sugar:Math.max(0, Math.min(5, parseInt(o.sugar) || 0)), hot:!!o.hot, other:str(o.other,60), notes:str(o.notes,80), label:str(o.label,30) };
}
function orderText(o){
  if(!o) return "No order";
  const drink = o.drink === "Other" ? (o.other || "Something else") : o.drink;
  const parts = [(o.size ? o.size + " " : "") + drink.toLowerCase()];
  if(o.milk && o.milk !== "Full cream") parts.push(o.milk.toLowerCase());
  if(o.strength && o.strength !== "Normal") parts.push(o.strength.toLowerCase());
  if(o.sugar) parts.push(o.sugar + (o.sugar === 1 ? " sugar" : " sugars"));
  if(o.hot) parts.push("extra hot");
  if(o.notes) parts.push(o.notes);
  const s = parts.join(", ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ---------- state ---------- */
const S = {
  stage:"loading", uid:null, email:null, team:null, teamLoaded:false, me:null, meLoaded:false, invite:null,
  members:{}, runs:[], answers:{}, tab:"run", sheet:null, alerted:new Set(), openDetails:new Set(),
  swReg:null, alerts:"checking", sound:LS.get("sound", true), pendingRun:null, linkError:"", banner:"",
};
let app, auth, db, fns;
const unsubs = []; const answerSubs = new Map();

/* ---------- firebase ---------- */
function initFirebase(){
  app = initializeApp(EMU ? {apiKey:"demo-key", authDomain:"localhost", projectId:"demo-coffee", appId:"demo"} : firebaseConfig);
  auth = getAuth(app); db = getFirestore(app); fns = getFunctions(app, FUNCTIONS_REGION);
  if(EMU){
    connectAuthEmulator(auth, "http://127.0.0.1:9099", {disableWarnings:true});
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
    connectFunctionsEmulator(fns, "127.0.0.1", 5001);
  }
}
function stopAll(){ unsubs.splice(0).forEach(u => { try{ u(); }catch(e){} }); answerSubs.forEach(u => { try{ u(); }catch(e){} }); answerSubs.clear(); }
function listen(ref, onNext){
  const u = onSnapshot(ref, onNext, err => { console.warn("listen failed", err); if(err.code === "permission-denied") return; S.banner = "Lost touch with the server. Close and reopen the app if this stays."; schedule(); });
  unsubs.push(u); return u;
}

function onSignedIn(user){
  S.uid = user.uid; S.email = user.email;
  listen(doc(db, "config", "team"), snap => { S.team = snap.exists() ? snap.data() : null; S.teamLoaded = true; if(isOwner()) watchInvite(); decideStage(); });
  listen(doc(db, "members", S.uid), snap => {
    const was = !!S.me; S.me = snap.exists() ? snap.data() : null; S.meLoaded = true;
    if(S.me && !was) startTeamData();
    if(!S.me && was){ stopTeamData(); toast("You're no longer on the team."); }
    decideStage();
  });
}
let teamUnsubs = [];
function startTeamData(){
  stopTeamData();
  teamUnsubs.push(onSnapshot(collection(db, "members"), snap => { S.members = Object.fromEntries(snap.docs.map(d => [d.id, d.data()])); schedule(); }, e => console.warn(e)));
  teamUnsubs.push(onSnapshot(query(collection(db, "runs"), orderBy("createdAt", "desc"), limit(300)), snap => {
    S.runs = snap.docs.map(d => ({...d.data(), id:d.id})).filter(r => typeof r.by === "string");
    syncAnswerSubs(); schedule();
  }, e => console.warn(e)));
  syncAlertsState();
}
function stopTeamData(){ teamUnsubs.splice(0).forEach(u => u()); answerSubs.forEach(u => u()); answerSubs.clear(); S.members = {}; S.runs = []; S.answers = {}; }
function syncAnswerSubs(){
  const live = new Set(openRuns().map(r => r.id));
  for(const id of live) if(!answerSubs.has(id)){
    answerSubs.set(id, onSnapshot(collection(db, "runs", id, "answers"), snap => { S.answers[id] = Object.fromEntries(snap.docs.map(d => [d.id, d.data()])); schedule(); }, e => console.warn(e)));
  }
  for(const [id, u] of answerSubs) if(!live.has(id)){ u(); answerSubs.delete(id); delete S.answers[id]; }
}
let inviteUnsub = null;
function watchInvite(){ if(inviteUnsub) return; inviteUnsub = onSnapshot(doc(db, "secrets", "invite"), s => { S.invite = s.exists() ? s.data().code : null; schedule(); }, () => {}); unsubs.push(() => { inviteUnsub && inviteUnsub(); inviteUnsub = null; }); }

const isOwner = () => !!(S.team && S.uid && S.team.owner === S.uid);
function decideStage(){
  if(!S.uid) return;
  if(!S.teamLoaded || !S.meLoaded){ S.stage = "loading"; }
  else if(!S.team) S.stage = "create-team";
  else if(!S.me) S.stage = "join";
  else S.stage = "app";
  schedule();
}

/* ---------- derived ---------- */
function openRuns(){ const now = Date.now(); return S.runs.filter(r => r.status === "open" && now - (r.createdAt || 0) < STALE_MS); }
const invitedOf = r => Array.isArray(r.invited) ? r.invited.filter(u => typeof u === "string") : [];
const ans = (runId, uid) => { const a = S.answers[runId]?.[uid]; return a && typeof a === "object" ? a : null; };
function pendingInvites(){ return openRuns().filter(r => r.by !== S.uid && invitedOf(r).includes(S.uid) && S.answers[r.id] && !ans(r.id, S.uid)); }
function runOrders(r){
  if(r.status === "done") return (Array.isArray(r.orders) ? r.orders : []).map(o => ({uid:str(o.uid,128), order:cleanOrder(o.order)})).filter(o => o.uid && o.order);
  return [...new Set([r.by, ...invitedOf(r)])].map(u => { const a = ans(r.id, u); return a?.answer === "yes" ? {uid:u, order:cleanOrder(a.order)} : null; }).filter(o => o && o.order);
}
function nm(uid){ return str(S.members[uid]?.name, 40) || (uid === S.uid ? str(S.me?.name, 40) : "") || "Former member"; }
function first(uid){ return uid === S.uid ? "You" : nm(uid).split(" ")[0]; }
function av(uid, cls = ""){ const n = nm(uid); const ini = n.split(/\s+/).filter(Boolean).slice(0,2).map(w => w[0]).join("").toUpperCase() || "?"; return `<span class="av ${cls}" aria-hidden="true">${esc(ini)}</span>`; }
function tally(){
  const t = {}; const E = u => (t[u] ??= {shouts:0, given:0, received:0, lastShout:0});
  Object.keys(S.members).forEach(E);
  for(const r of S.runs){
    if(r.status !== "done") continue;
    const others = runOrders(r).filter(o => o.uid !== r.by);
    if(!others.length) continue;
    const b = E(r.by); b.shouts++; b.given += others.length; b.lastShout = Math.max(b.lastShout, r.completedAt || r.createdAt || 0);
    others.forEach(o => E(o.uid).received++);
  }
  return t;
}
function nextUp(){
  const ids = Object.keys(S.members); if(ids.length < 2) return null;
  const t = tally();
  ids.sort((a,b) => (t[a].given - t[a].received) - (t[b].given - t[b].received) || t[a].lastShout - t[b].lastShout || t[a].shouts - t[b].shouts || a.localeCompare(b));
  return {uid:ids[0], ...t[ids[0]]};
}

/* ---------- rendering ---------- */
const pendingEls = new Set();
function safeRender(el, html){
  const a = document.activeElement;
  if(a && el.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)){ pendingEls.add(el); return; }
  if(el._last === html) return;
  // Keep what someone has typed when the same screen re-draws (for example after an error message appears).
  const key = S.stage + ":" + S.tab, kept = {};
  if(el._key === key) el.querySelectorAll("input[id]:not([type=checkbox]):not([type=radio])").forEach(i => { if(i.value !== i.defaultValue) kept[i.id] = i.value; });
  el._last = html; el._key = key; el.innerHTML = html;
  for(const [id, v] of Object.entries(kept)){ const i = el.querySelector("#" + CSS.escape(id)); if(i) i.value = v; }
}
document.addEventListener("focusout", () => setTimeout(() => { if([...pendingEls].some(el => !el.contains(document.activeElement))){ pendingEls.clear(); schedule(); } }, 0));
let raf = 0;
function schedule(){ if(raf) return; raf = requestAnimationFrame(() => { raf = 0; render(); if(S.stage === "app") checkAlerts(); }); }

function render(){
  const inApp = S.stage === "app";
  $("#who").innerHTML = inApp ? `${av(S.uid, "sm")}<span>${esc(nm(S.uid))}</span>` : "";
  const bn = $("#banner"); bn.hidden = !S.banner; bn.textContent = S.banner;
  $("#tabs").hidden = !inApp;
  let html;
  if(inApp){
    ["run","tally","history","me"].forEach(t => { const b = $("#tab-" + t); if(S.tab === t) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
    const pend = pendingInvites().length;
    setBadge("run", pend);
    document.title = pend ? `(${pend}) Coffee run! · Coffee Please` : "Coffee Please";
    try{ if(navigator.setAppBadge){ pend ? navigator.setAppBadge(pend) : navigator.clearAppBadge(); } }catch(e){}
    html = {run:viewRun, tally:viewTally, history:viewHistory, me:viewMe}[S.tab]();
  } else {
    html = ({loading:viewLoading, setup:viewSetup, install:viewInstall, signin:viewSignin, "check-email":viewCheckEmail, "link-ios":viewLinkIOS, "link-email":viewLinkEmail, "create-team":viewCreateTeam, join:viewJoin})[S.stage]();
  }
  safeRender($("#main"), `<section class="view">${html}</section>`);
}
function setBadge(tab, n){ const el = $("#tab-" + tab); let bd = el.querySelector(".badge"); if(!n){ bd && bd.remove(); return; } if(!bd){ bd = document.createElement("span"); bd.className = "badge"; el.appendChild(bd); } bd.textContent = n; }

/* ----- pre-app screens ----- */
const viewLoading = () => `<div class="card"><p class="muted">Loading…</p></div>`;
const viewSetup = () => `<div class="card"><h2>Almost there</h2><p>This copy of Coffee Please hasn't been connected to Firebase yet. Fill in <b>docs/config.js</b> using steps 3 and 5 of the deploy guide, then push the change to GitHub.</p></div>`;

function viewInstall(){
  const code = inviteFromHash() || LS.get("invite", "");
  return `<div class="card">
    <p class="eyebrow">Step 1 of 2</p>
    <h1>Add Coffee Please to your Home Screen</h1>
    <p>On iPhone, alerts only work from the Home Screen app. It takes 20 seconds.</p>
    <ol class="steps">
      <li><span>Tap the <b>Share</b> button in Safari's toolbar (the square with an arrow pointing up).</span></li>
      <li><span>Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.</span></li>
      <li><span>Close Safari and open <b>Coffee</b> from your Home Screen. You'll sign in there.</span></li>
    </ol>
    ${code ? `<p class="small muted">If the app asks for an invite code, it's <span class="code">${esc(code)}</span></p>` : ""}
  </div>
  <div class="row"><button class="btn ghost small" data-act="skip-install">Continue in Safari without alerts</button></div>`;
}
function viewSignin(){
  return `<form class="card" id="signinForm">
    <p class="eyebrow">${isIOS && isStandalone() ? "Step 2 of 2" : "Welcome"}</p>
    <h1>Sign in</h1>
    <p>We'll email you a link. No password needed.</p>
    <div class="field"><label for="si-email">Your email</label><input id="si-email" type="email" autocomplete="email" inputmode="email" required value="${esc(LS.get("email", ""))}"></div>
    ${S.linkError ? `<p class="small" style="color:var(--bad)">${esc(S.linkError)}</p>` : ""}
    <div class="row"><button class="btn primary wide" type="submit">Email me a sign-in link</button></div>
  </form>`;
}
function viewCheckEmail(){
  const standaloneIOS = isIOS && isStandalone();
  return `<div class="card">
    <h1>Check your email</h1>
    <p>We sent a sign-in link to <b>${esc(LS.get("email", ""))}</b>. It can take a minute. Check junk mail too.</p>
    ${standaloneIOS ? `<p><b>On iPhone:</b> in the email, press and hold the sign-in link, tap <b>Copy Link</b>, then come back here and paste it below.</p>` : `<p>Open the link on this device. You'll be signed in straight away.</p>`}
  </div>
  <form class="card" id="pasteForm">
    <div class="field"><label for="paste-link">${standaloneIOS ? "Paste the sign-in link" : "Or paste the sign-in link here"}</label><input id="paste-link" type="url" autocomplete="off" placeholder="https://…"></div>
    ${S.linkError ? `<p class="small" style="color:var(--bad)">${esc(S.linkError)}</p>` : ""}
    <div class="row"><button class="btn primary wide" type="submit">Sign in</button><button class="btn ghost" type="button" data-act="restart-signin">Use a different email</button></div>
  </form>`;
}
function viewLinkIOS(){
  return `<div class="card">
    <h1>Finish signing in</h1>
    <p><b>Using Coffee Please from your Home Screen?</b> Copy this sign-in link, open the Coffee app, and paste it there.</p>
    <div class="row"><button class="btn primary wide" data-act="copy-link">Copy sign-in link</button></div>
    <p class="small muted">Not installed yet? You can sign in here in Safari instead, but you won't get alerts.</p>
    <div class="row"><button class="btn" data-act="signin-here">Sign in here in Safari</button></div>
  </div>`;
}
function viewLinkEmail(){
  return `<form class="card" id="linkEmailForm"><h2>Confirm your email</h2><p>Enter the email address the sign-in link was sent to.</p>
    <div class="field"><label for="le-email">Email</label><input id="le-email" type="email" autocomplete="email" required></div>
    ${S.linkError ? `<p class="small" style="color:var(--bad)">${esc(S.linkError)}</p>` : ""}
    <div class="row"><button class="btn primary wide" type="submit">Sign in</button></div></form>`;
}
function viewCreateTeam(){
  return `<form class="card" id="createForm">
    <p class="eyebrow">First time setup</p>
    <h1>Start your coffee team</h1>
    <p>You're the first person here, so you'll own the team. You'll get an invite link to share with everyone else.</p>
    <div class="field"><label for="ct-name">Your name, as the team will see it</label><input id="ct-name" type="text" maxlength="40" autocomplete="name" required></div>
    <div class="row"><button class="btn primary wide" type="submit">Create the team</button></div>
  </form>
  <div class="row"><button class="btn ghost small" data-act="signout">Sign out (${esc(S.email || "")})</button></div>`;
}
function viewJoin(){
  const code = inviteFromHash() || LS.get("invite", "");
  return `<form class="card" id="joinForm">
    <p class="eyebrow">Welcome</p>
    <h1>Join the coffee team</h1>
    <p>When someone's at the café they tap one button and everyone gets an alert. Say yes, pick your usual, and it lands on their order. The app counts who's shouted.</p>
    <div class="field"><label for="jn-name">Your name, as the team will see it</label><input id="jn-name" type="text" maxlength="40" autocomplete="name" required></div>
    <div class="field"><label for="jn-code">Invite code</label><input id="jn-code" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" required value="${esc(code)}"><span class="small muted">It's the part after <b>#join=</b> in your invite link.</span></div>
    ${S.linkError ? `<p class="small" style="color:var(--bad)">${esc(S.linkError)}</p>` : ""}
    <div class="row"><button class="btn primary wide" type="submit">Join</button></div>
  </form>
  <div class="row"><button class="btn ghost small" data-act="signout">Sign out (${esc(S.email || "")})</button></div>`;
}

/* ----- app views ----- */
function alertsCard(compact){
  const st = S.alerts;
  if(st === "on" || st === "checking") return "";
  let body;
  if(st === "ios-browser") body = `<h3>Alerts need the Home Screen app</h3><p class="small">In Safari tap <b>Share</b>, then <b>Add to Home Screen</b>, and open Coffee from there.</p>`;
  else if(st === "unsupported") body = `<h3>This browser can't show alerts</h3><p class="small">Open Coffee Please in Chrome, Edge, Firefox or Safari to get alerts.</p>`;
  else if(st === "denied") body = `<h3>Alerts are blocked on this device</h3><p class="small">${isIOS ? "Open <b>Settings</b>, <b>Notifications</b>, <b>Coffee</b>, and turn on <b>Allow Notifications</b>." : "Allow notifications for this site in your browser's site settings, then reload."}</p>`;
  else body = `<h3>Turn on alerts for this ${isIOS || /Android/.test(navigator.userAgent) ? "phone" : "device"}</h3><p class="small">So you hear about coffee runs even when the app is closed.</p><div class="row"><button class="btn primary" data-act="enable-alerts">Turn on alerts</button></div>`;
  return `<div class="card accent">${body}</div>`;
}

function viewRun(){
  const open = openRuns();
  const mine = open.filter(r => r.by === S.uid);
  const theirs = open.filter(r => r.by !== S.uid && invitedOf(r).includes(S.uid));
  let h = alertsCard() + theirs.map(participantPanel).join("") + mine.map(hostPanel).join("");
  if(!mine.length){
    const n = nextUp(); const others = Object.keys(S.members).filter(u => u !== S.uid).length;
    h += `<div class="hero">
      <button class="bigbtn" data-act="start-open" aria-label="Coffee please: ask the team">Coffee<br>please?<small>Ask the team</small></button>
      <p class="hint">${others ? `You'll ask ${others} ${others === 1 ? "person" : "people"}. ` : `No one else has joined yet. ${isOwner() ? "Share your invite link from the Me tab." : ""} `}${n ? (n.uid === S.uid ? "By the tally, it's your shout." : `By the tally, it's ${esc(first(n.uid))}'s shout.`) : ""}</p>
    </div>`;
  }
  return h;
}
function participantPanel(r){
  const me = ans(r.id, S.uid);
  const going = runOrders(r).filter(o => o.uid !== S.uid);
  const loaded = !!S.answers[r.id];
  let body;
  if(!loaded) body = `<p class="muted small">Loading answers…</p>`;
  else if(!me) body = `<div class="row"><button class="btn primary wide" data-act="yes" data-run="${esc(r.id)}">Yes please</button><button class="btn wide" data-act="no" data-run="${esc(r.id)}">No thanks</button></div>`;
  else if(me.answer === "yes") body = `<div class="mine"><p class="eyebrow">Your order</p><b>${esc(orderText(cleanOrder(me.order)))}</b>
      <div class="row"><button class="btn small" data-act="yes" data-run="${esc(r.id)}">Change order</button><button class="btn small ghost" data-act="drop" data-run="${esc(r.id)}">Drop out</button></div></div>`;
  else body = `<div class="row split"><span class="muted">You said no thanks.</span><button class="btn small" data-act="yes" data-run="${esc(r.id)}">Actually, yes please</button></div>`;
  return `<article class="docket">
    <div class="docket-head"><div class="stack"><p class="eyebrow">Coffee run · ${esc(first(r.by))}'s shout</p><h2>${esc(nm(r.by))} is at ${esc(r.cafe || "the café")}</h2></div><span class="timer">${until(r.closesAt)}</span></div>
    ${body}
    ${going.length ? `<p class="small muted">Also in: ${going.map(o => esc(first(o.uid))).join(", ")}</p>` : ""}
  </article>`;
}
function docketText(r, orders){
  const groups = new Map();
  orders.forEach(o => { const k = orderText(o.order); const g = groups.get(k) || {n:0, who:[]}; g.n++; g.who.push(nm(o.uid).split(" ")[0]); groups.set(k, g); });
  const lines = [...groups].map(([k, g]) => `${g.n}× ${k}\n   (${g.who.join(", ")})`);
  return `COFFEE RUN · ${r.cafe || "Café"}\n${fmtDate(r.createdAt || Date.now())}\n\n${lines.join("\n") || "No orders yet"}\n\n${orders.length} ${orders.length === 1 ? "drink" : "drinks"}`;
}
function hostPanel(r){
  const inv = invitedOf(r).filter(u => u !== S.uid);
  const orders = runOrders(r);
  const rows = inv.map(u => {
    const x = ans(r.id, u);
    if(!x) return `<div class="line">${av(u)}<div class="what"><b>${esc(nm(u))}</b><span>Hasn't answered</span></div><span class="pill wait">Waiting</span></div>`;
    if(x.answer !== "yes") return `<div class="line">${av(u)}<div class="what"><b>${esc(nm(u))}</b><span>No thanks</span></div><span class="pill no">No</span></div>`;
    return `<div class="line">${av(u)}<div class="what"><b>${esc(nm(u))}</b><span>${esc(orderText(cleanOrder(x.order)))}</span></div><span class="pill">Yes</span></div>`;
  }).join("");
  const mineA = ans(r.id, S.uid);
  const mineRow = mineA?.answer === "yes"
    ? `<div class="line">${av(S.uid)}<div class="what"><b>You</b><span>${esc(orderText(cleanOrder(mineA.order)))}</span></div><button class="btn small" data-act="yes" data-run="${esc(r.id)}">Change</button></div>`
    : `<div class="line">${av(S.uid)}<div class="what"><b>You</b><span>Getting one for yourself?</span></div><button class="btn small" data-act="yes" data-run="${esc(r.id)}">Add mine</button></div>`;
  const answered = inv.filter(u => ans(r.id, u)).length;
  return `<article class="docket">
    <div class="docket-head"><div class="stack"><p class="eyebrow">Your coffee run · your shout</p><h2>${esc(r.cafe || "At the café")}</h2></div><span class="timer">${until(r.closesAt)}</span></div>
    <div class="row"><span class="pill wait">${answered} of ${inv.length} answered</span></div>
    <div class="lines">${rows}${mineRow}</div>
    <hr class="tear">
    <div class="stack"><div class="row split"><p class="eyebrow">For the barista</p><button class="btn small" data-act="copy-docket" data-run="${esc(r.id)}">Copy order</button></div>
      <div class="ticket">${esc(docketText(r, orders))}</div></div>
    <div class="row"><button class="btn primary wide" data-act="complete" data-run="${esc(r.id)}">Bought them. Record it</button><button class="btn ghost danger" data-act="cancel" data-run="${esc(r.id)}" data-confirm="Tap again to cancel">Cancel run</button></div>
  </article>`;
}
function viewTally(){
  const t = tally(); const n = nextUp();
  const ids = Object.keys(S.members).sort((a,b) => (t[b].given - t[b].received) - (t[a].given - t[a].received) || nm(a).localeCompare(nm(b)));
  const any = ids.some(u => t[u].shouts);
  return `<div class="card"><p class="eyebrow">Next shout</p>
    ${n ? `<div class="nextup">${av(n.uid)}<div><div class="big">${n.uid === S.uid ? "You" : esc(nm(n.uid))}</div><p class="small muted">${any ? `Has had ${n.received} ${n.received === 1 ? "coffee" : "coffees"} shouted and bought ${n.given} for others.` : "No shouts recorded yet, so anyone can start."}</p></div></div>` : `<p class="muted">The tally starts once at least two people have joined.</p>`}</div>
  <div class="card"><div class="row split"><h3>Who's shouted</h3><span class="small muted">Bal. = bought for others − had</span></div>
    <div class="tablewrap"><table><thead><tr><th>Person</th><th>Shouts</th><th>Bought</th><th>Had</th><th>Bal.</th></tr></thead><tbody>
    ${ids.map(u => { const x = t[u], bal = x.given - x.received; return `<tr class="${n && n.uid === u ? "next" : ""}"><td class="person"><div>${av(u, "sm")}<span>${esc(u === S.uid ? "You" : nm(u))}</span></div></td><td>${x.shouts}</td><td>${x.given}</td><td>${x.received}</td><td class="${bal > 0 ? "bal-pos" : bal < 0 ? "bal-neg" : ""}">${bal > 0 ? "+" : ""}${bal}</td></tr>`; }).join("")}
    </tbody></table></div></div>`;
}
function viewHistory(){
  const runs = S.runs.filter(r => r.status === "done" || r.status === "cancelled").slice(0, 80);
  if(!runs.length) return `<div class="card"><h3>No coffee runs yet</h3><p class="muted">Finished runs show up here with who ordered what.</p></div>`;
  return runs.map(r => {
    const orders = runOrders(r);
    const lines = orders.map(o => `<div class="hl"><span>${esc(first(o.uid))}</span><span>${esc(orderText(o.order))}</span></div>`).join("");
    const cancelled = r.status === "cancelled";
    return `<details class="run" data-id="${esc(r.id)}"${S.openDetails.has(r.id) ? " open" : ""}>
      <summary><span class="t">${esc(r.cafe || "Café")} · ${cancelled ? "cancelled" : (r.by === S.uid ? "your shout" : esc(first(r.by)) + "'s shout")}</span>
      <span class="amt">${cancelled ? "" : orders.length + " ☕"}</span>
      <span class="m">${fmtDate(r.completedAt || r.createdAt)}${r.autoClosed ? " · recorded automatically" : ""}</span></summary>
      <div class="body">${lines || `<p class="small muted">No orders.</p>`}
      ${isOwner() ? `<div class="row"><button class="btn small ghost danger" data-act="delete-run" data-run="${esc(r.id)}" data-confirm="Tap again to delete">Delete this run</button></div>` : ""}</div></details>`;
  }).join("");
}
function viewMe(){
  const m = S.me || {};
  const favs = Array.isArray(m.favourites) ? m.favourites.map(cleanOrder).filter(Boolean) : [];
  const alertsLine = {on:"On for this device.", checking:"Checking…", off:"Off for this device.", denied:"Blocked for this device.", "ios-browser":"Need the Home Screen app.", unsupported:"Not available in this browser."}[S.alerts];
  return `<form class="card" id="nameForm"><h3>Your name</h3>
      <div class="row"><input id="me-name" type="text" maxlength="40" value="${esc(str(m.name, 40))}" aria-label="Your name" style="flex:1"><button class="btn" type="submit">Save</button></div>
      <p class="small muted">Signed in as ${esc(S.email || "")}</p></form>
    <div class="card"><h3>Your saved orders</h3>
      ${favs.length ? `<div>${favs.map((o, i) => `<div class="favrow"><div class="what"><b>${esc(o.label || "Order " + (i + 1))}</b><div class="small muted">${esc(orderText(o))}</div></div><div class="row"><button class="btn small" data-act="fav-edit" data-i="${i}">Edit</button><button class="btn small ghost danger" data-act="fav-del" data-i="${i}" data-confirm="Delete?">Delete</button></div></div>`).join("")}</div>` : `<p class="muted">Save your usual so saying yes takes one tap.</p>`}
      <div class="row"><button class="btn" data-act="fav-new">Add a saved order</button></div></div>
    <div class="card"><h3>Alerts</h3>
      <p class="small">${alertsLine}</p>
      ${alertsCard()}
      ${S.alerts === "on" ? `<div class="row"><button class="btn" data-act="test-alert">Send a test alert</button></div><p class="small muted">Close the app after tapping. The alert should arrive within a few seconds.</p>` : ""}
      <label class="check" for="me-notify"><input type="checkbox" id="me-notify" ${m.notifyAnswers === false ? "" : "checked"}> Alert me as people answer my runs</label>
      <label class="check" for="me-sound"><input type="checkbox" id="me-sound" ${S.sound ? "checked" : ""}> Chime when a run starts while the app is open</label>
    </div>
    ${teamCard()}
    <div class="card"><div class="row split"><button class="btn" data-act="signout">Sign out</button><button class="btn ghost danger" data-act="leave" data-confirm="Tap again to leave">Leave the team</button></div>
      <p class="small muted">Leaving keeps your past coffees in the tally.</p></div>`;
}
function teamCard(){
  const ids = Object.keys(S.members).sort((a,b) => nm(a).localeCompare(nm(b)));
  const link = S.invite ? `${APP_URL}#join=${S.invite}` : "";
  return `<div class="card"><h3>The team (${ids.length})</h3>
    ${ids.map(u => `<div class="favrow"><div class="row">${av(u, "sm")}<span>${esc(u === S.uid ? "You" : nm(u))}${S.team?.owner === u ? ' <span class="pill">owner</span>' : ""}</span></div>${isOwner() && u !== S.uid ? `<button class="btn small ghost danger" data-act="remove-member" data-uid="${esc(u)}" data-confirm="Tap again to remove">Remove</button>` : ""}</div>`).join("")}
    ${isOwner() ? `<div class="stack"><p class="lbl">Invite link</p>${link ? `<div class="code">${esc(link)}</div>` : `<p class="small muted">Loading…</p>`}
      <div class="row"><button class="btn primary" data-act="copy-invite" ${link ? "" : "disabled"}>Copy invite link</button><button class="btn ghost small" data-act="new-invite" data-confirm="Tap again: old links stop working">Make a new link</button></div>
      <p class="small muted">Anyone with this link can join. Removing someone also makes a new link, so their old one stops working.</p></div>`
      : `<p class="small muted">To add someone, ask ${esc(nm(S.team?.owner))} for the invite link.</p>`}
  </div>`;
}

/* ---------- sheets ---------- */
function openSheet(kind, html){ S.sheet = kind; $("#sheetBody").innerHTML = html; $("#sheet").hidden = false; document.body.classList.add("locked"); setTimeout(() => { const f = $("#sheetBody").querySelector("[data-autofocus]") || $("#sheetBody").querySelector("button, input, select"); f && f.focus({preventScroll:true}); }, 40); }
function closeSheet(){ $("#sheet").hidden = true; S.sheet = null; document.body.classList.remove("locked"); schedule(); }
$("#sheet").addEventListener("click", e => { if(e.target.id === "sheet") closeSheet(); });
document.addEventListener("keydown", e => { if(e.key === "Escape" && S.sheet) closeSheet(); });

function incomingSheet(r){
  openSheet("incoming:" + r.id, `<div class="incoming"><div class="cup">${CUP}</div>
    <p class="eyebrow">Coffee run · ${until(r.closesAt)}</p>
    <h2 id="sheet-title">${esc(nm(r.by))} is at ${esc(r.cafe || "the café")}</h2>
    <p class="muted">Want a coffee? It's ${esc(first(r.by))}'s shout.</p></div>
  <div class="row"><button class="btn primary wide" data-act="yes" data-run="${esc(r.id)}" data-autofocus>Yes please</button><button class="btn wide" data-act="no" data-run="${esc(r.id)}">No thanks</button></div>`);
}
function startSheet(){
  const others = Object.keys(S.members).filter(u => u !== S.uid).sort((a,b) => nm(a).localeCompare(nm(b)));
  openSheet("start", `<h2 id="sheet-title">Who wants a coffee?</h2>
  <form id="startForm" class="stack" style="gap:16px">
    <div class="field"><label for="st-cafe">Where are you?</label><input id="st-cafe" type="text" maxlength="60" placeholder="Café name" value="${esc(LS.get("lastCafe", ""))}" data-autofocus></div>
    <fieldset><legend>Answer within</legend><div class="seg">${[5,10,15,20].map(m => `<label><input type="radio" name="st-mins" value="${m}" ${m === 10 ? "checked" : ""}><span>${m} min</span></label>`).join("")}</div></fieldset>
    <fieldset><legend>Ask</legend>${others.length ? `<div class="seg">${others.map(u => `<label><input type="checkbox" name="st-who" value="${esc(u)}" checked><span>${esc(nm(u).split(" ")[0])}</span></label>`).join("")}</div>` : `<p class="small muted">No one else has joined yet.</p>`}</fieldset>
    <div class="row"><button class="btn primary wide" type="submit" ${others.length ? "" : "disabled"}>Send the ask</button><button class="btn ghost" type="button" data-act="sheet-close">Not now</button></div>
  </form>`);
}
function orderFormHTML(o, opts){
  o = o || {drink:"Flat white", size:"Regular", milk:"Full cream", strength:"Normal", sugar:0};
  const sel = (id, list, v) => `<select id="${id}">${list.map(x => `<option ${x === v ? "selected" : ""}>${esc(x)}</option>`).join("")}</select>`;
  return `<div class="stack" style="gap:14px">
    <div class="grid2"><div class="field"><label for="o-drink">Drink</label>${sel("o-drink", DRINKS, o.drink)}</div><div class="field"><label for="o-milk">Milk</label>${sel("o-milk", MILKS, o.milk || "Full cream")}</div></div>
    <div class="field" id="o-other-wrap" ${o.drink === "Other" ? "" : "hidden"}><label for="o-other">What would you like?</label><input id="o-other" type="text" maxlength="60" value="${esc(o.other || "")}"></div>
    <fieldset><legend>Size</legend><div class="seg">${SIZES.map(s => `<label><input type="radio" name="o-size" value="${s}" ${s === (o.size || "Regular") ? "checked" : ""}><span>${s}</span></label>`).join("")}</div></fieldset>
    <div class="grid2"><div class="field"><label for="o-strength">Strength</label>${sel("o-strength", STRENGTHS, o.strength || "Normal")}</div>
      <fieldset><legend>Sugars</legend><div class="seg">${[0,1,2,3].map(n => `<label><input type="radio" name="o-sugar" value="${n}" ${n === (o.sugar || 0) ? "checked" : ""}><span>${n}</span></label>`).join("")}</div></fieldset></div>
    <label class="check" for="o-hot"><input type="checkbox" id="o-hot" ${o.hot ? "checked" : ""}> Extra hot</label>
    <div class="field"><label for="o-notes">Anything else</label><input id="o-notes" type="text" maxlength="80" placeholder="e.g. in a mug" value="${esc(o.notes || "")}"></div>
    ${opts.save ? `<label class="check" for="o-save"><input type="checkbox" id="o-save" checked> Save to my orders</label>` : ""}
    <div class="field"><label for="o-label">Name it</label><input id="o-label" type="text" maxlength="30" placeholder="My usual" value="${esc(o.label || "")}"></div>
  </div>`;
}
function readOrderForm(){
  const drink = $("#o-drink").value;
  return { drink, size:document.querySelector('input[name="o-size"]:checked')?.value || "Regular", milk:$("#o-milk").value, strength:$("#o-strength").value,
    sugar:parseInt(document.querySelector('input[name="o-sugar"]:checked')?.value || "0"), hot:$("#o-hot").checked,
    other: drink === "Other" ? $("#o-other").value.trim().slice(0, 60) : "", notes:$("#o-notes").value.trim().slice(0, 80), label:$("#o-label").value.trim().slice(0, 30) };
}
function favourites(){ return (Array.isArray(S.me?.favourites) ? S.me.favourites : []).map(cleanOrder).filter(Boolean); }
function orderSheet(r){
  const favs = favourites();
  const cur = cleanOrder(ans(r.id, S.uid)?.order);
  const curIdx = cur ? favs.findIndex(f => orderText(f) === orderText(cur)) : -1;
  const pick = curIdx >= 0 ? curIdx : (cur ? "new" : (favs.length ? 0 : "new"));
  openSheet("order:" + r.id, `<h2 id="sheet-title">What are you having?</h2>
    <p class="muted small">${esc(nm(r.by))} · ${esc(r.cafe || "the café")} · ${until(r.closesAt)}</p>
    <form id="orderForm" data-run="${esc(r.id)}" class="stack" style="gap:16px">
      <div class="favs">
        ${favs.map((f, i) => `<label class="fav"><input type="radio" name="pick" value="${i}" ${pick === i ? "checked" : ""}><div class="what"><b>${esc(f.label || "Saved order " + (i + 1))}</b><span>${esc(orderText(f))}</span></div></label>`).join("")}
        <label class="fav"><input type="radio" name="pick" value="new" ${pick === "new" ? "checked" : ""}><div class="what"><b>${favs.length ? "Something different" : "New order"}</b><span>Build an order${favs.length ? "" : " and save it for next time"}</span></div></label>
      </div>
      <div id="newOrder" ${pick === "new" ? "" : "hidden"}>${orderFormHTML(curIdx < 0 ? cur : null, {save:true})}</div>
      <div class="row"><button class="btn primary wide" type="submit">Send my order</button><button class="btn ghost" type="button" data-act="sheet-close">Back</button></div>
    </form>`);
}
function favSheet(i){
  const o = i != null ? favourites()[i] : null;
  openSheet("fav", `<h2 id="sheet-title">${o ? "Edit saved order" : "Add a saved order"}</h2>
    <form id="favForm" data-i="${i ?? ""}" class="stack" style="gap:16px">${orderFormHTML(o, {save:false})}
    <div class="row"><button class="btn primary wide" type="submit">Save</button><button class="btn ghost" type="button" data-act="sheet-close">Cancel</button></div></form>`);
}

/* ---------- alerts on this device ---------- */
let swReady = Promise.resolve();
async function registerSW(){
  if(!("serviceWorker" in navigator)) return;
  try{ S.swReg = await navigator.serviceWorker.register("sw.js"); await navigator.serviceWorker.ready; }catch(e){ console.warn("service worker failed", e); }
  navigator.serviceWorker.addEventListener("message", e => { if(e.data?.type === "open") handleOpenUrl(e.data.url); });
}
async function syncAlertsState(){
  await swReady;
  if(isIOS && !isStandalone()){ S.alerts = "ios-browser"; return schedule(); }
  if(!pushSupported || !S.swReg){ S.alerts = "unsupported"; return schedule(); }
  if(Notification.permission === "denied"){ S.alerts = "denied"; return schedule(); }
  try{
    let sub = await S.swReg.pushManager.getSubscription();
    if(!sub && Notification.permission === "granted"){ try{ sub = await S.swReg.pushManager.subscribe({userVisibleOnly:true, applicationServerKey:b64ToU8(VAPID_PUBLIC_KEY)}); }catch(e){} }
    if(sub){ await saveSub(sub); S.alerts = "on"; } else S.alerts = "off";
  }catch(e){ console.warn(e); S.alerts = "off"; }
  schedule();
}
function enableAlerts(){
  if(!S.swReg){ toast("Alerts aren't available in this browser."); return; }
  // Called straight from the tap: Safari only shows the permission prompt in response to one.
  S.swReg.pushManager.subscribe({userVisibleOnly:true, applicationServerKey:b64ToU8(VAPID_PUBLIC_KEY)})
    .then(async sub => { await saveSub(sub); S.alerts = "on"; schedule(); toast("Alerts are on for this device"); })
    .catch(e => { console.warn(e); S.alerts = Notification.permission === "denied" ? "denied" : "off"; schedule(); toast(Notification.permission === "denied" ? "Alerts were blocked. See the steps on screen to turn them on." : "Couldn't turn on alerts: " + (e.message || e)); });
}
async function saveSub(sub){
  const j = sub.toJSON();
  const ref = doc(db, "pushSubs", S.uid);
  const snap = await getDoc(ref);
  let subs = snap.exists() && Array.isArray(snap.data().subs) ? snap.data().subs : [];
  const known = subs.find(s => s.endpoint === j.endpoint);
  if(known && Date.now() - (known.at || 0) < 7 * 864e5) return;
  subs = subs.filter(s => s.endpoint !== j.endpoint);
  subs.push({endpoint:j.endpoint, keys:{p256dh:j.keys.p256dh, auth:j.keys.auth}, device:(isIOS ? "iPhone" : /Android/.test(navigator.userAgent) ? "Android" : "Computer"), at:Date.now()});
  await setDoc(ref, {subs:subs.slice(-6)});
}

/* ---------- in-app alerts ---------- */
let AC = null;
document.addEventListener("pointerdown", () => { try{ if(!AC){ const A = window.AudioContext || window.webkitAudioContext; if(A) AC = new A(); } else if(AC.state === "suspended") AC.resume().catch(() => {}); }catch(e){} }, {capture:true});
function chime(){
  if(!S.sound || !AC) return;
  try{ const t = AC.currentTime; [784, 1175, 1568].forEach((f, i) => { const o = AC.createOscillator(), g = AC.createGain(), s = t + i * 0.16; o.type = "sine"; o.frequency.value = f; g.gain.setValueAtTime(0.0001, s); g.gain.exponentialRampToValueAtTime(0.22, s + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, s + 0.6); o.connect(g); g.connect(AC.destination); o.start(s); o.stop(s + 0.65); }); }catch(e){}
}
function checkAlerts(){
  const pend = pendingInvites();
  if(S.pendingRun){
    const r = S.runs.find(x => x.id === S.pendingRun);
    if(r && (r.status !== "open" || S.answers[r.id] !== undefined)){ S.pendingRun = null; S.tab = "run"; if(pend.includes(r)){ S.alerted.add(r.id); incomingSheet(r); } }
    else if(S.runs.length && !r){ S.pendingRun = null; }
  }
  for(const r of pend){
    if(S.alerted.has(r.id)) continue;
    S.alerted.add(r.id);
    if(document.visibilityState === "visible") chime();
    if(!S.sheet || S.sheet === "start") incomingSheet(r);
    else toast(`${first(r.by)} is at ${r.cafe || "the café"}. Coffee?`);
  }
  if(S.sheet && S.sheet.startsWith("incoming:") && !pend.some(r => "incoming:" + r.id === S.sheet)) closeSheet();
}
function handleOpenUrl(url){
  try{ const h = new URL(url).hash.slice(1); const run = new URLSearchParams(h).get("run"); if(run){ S.pendingRun = run; S.alerted.delete(run); } }catch(e){}
  if(S.stage === "app"){ S.tab = "run"; schedule(); }
}
setInterval(() => { if(S.stage === "app" && S.tab === "run" && openRuns().length){ $("#main")._last = null; schedule(); } }, 20000);
document.addEventListener("visibilitychange", () => { if(document.visibilityState === "visible" && S.stage === "app"){ $("#main")._last = null; schedule(); } });

/* ---------- writes ---------- */
async function write(fn, ok){ try{ await fn(); if(ok) toast(ok); return true; }catch(e){ console.warn(e); toast(errMsg(e)); return false; } }
const memberRef = () => doc(db, "members", S.uid);
async function setAnswer(runId, val){ const ref = doc(db, "runs", runId, "answers", S.uid); if(val) await setDoc(ref, {...val, at:Date.now()}); else await deleteDoc(ref); }
async function completeRun(r){
  const orders = runOrders(r).map(o => ({uid:o.uid, order:o.order}));
  if(!orders.length) return toast("No orders yet. Cancel the run instead if nobody wants one.");
  await write(() => updateDoc(doc(db, "runs", r.id), {status:"done", completedAt:Date.now(), orders}), "Shout recorded. Nice one");
}

/* ---------- sign-in ---------- */
function inviteFromHash(){ try{ return new URLSearchParams(location.hash.slice(1)).get("join") || ""; }catch(e){ return ""; } }
async function completeLink(email, link){
  S.linkError = "";
  try{
    await signInWithEmailLink(auth, email, link);
    LS.set("email", email); LS.del("awaitingLink");
    history.replaceState(null, "", APP_URL + (inviteFromHash() ? "#join=" + inviteFromHash() : ""));
  }catch(e){ S.linkError = errMsg(e); S.stage = S.stage === "link-email" ? "link-email" : "check-email"; schedule(); }
}

/* ---------- events ---------- */
document.addEventListener("click", async e => {
  const el = e.target.closest("[data-act]"); if(!el || el.tagName === "INPUT") return;
  const act = el.dataset.act;
  if(el.dataset.confirm){
    if(el.dataset.armed !== "1"){ el.dataset.armed = "1"; el._txt = el.textContent; el.textContent = el.dataset.confirm; setTimeout(() => { if(el.isConnected){ el.dataset.armed = ""; el.textContent = el._txt; } }, 4000); return; }
    el.dataset.armed = "";
  }
  const run = el.dataset.run ? S.runs.find(r => r.id === el.dataset.run) : null;
  switch(act){
    case "tab": S.tab = el.dataset.tab; schedule(); window.scrollTo(0, 0); break;
    case "sheet-close": closeSheet(); break;
    case "skip-install": LS.set("skipInstall", true); S.stage = "signin"; schedule(); break;
    case "restart-signin": S.linkError = ""; LS.del("awaitingLink"); S.stage = "signin"; schedule(); break;
    case "copy-link": copy(location.href, "Link copied. Now open Coffee from your Home Screen and paste it."); break;
    case "signin-here": { const em = LS.get("email", ""); if(em) completeLink(em, location.href); else { S.stage = "link-email"; schedule(); } break; }
    case "signout": stopAll(); stopTeamData(); await signOut(auth); break;
    case "start-open": startSheet(); break;
    case "yes": if(run) orderSheet(run); break;
    case "no": if(run){ closeSheet(); await write(() => setAnswer(run.id, {answer:"no", order:null}), "No worries"); } break;
    case "drop": if(run) await write(() => setAnswer(run.id, null), "You're out of this run"); break;
    case "copy-docket": if(run) copy(docketText(run, runOrders(run))); break;
    case "complete": if(run) await completeRun(run); break;
    case "cancel": if(run) await write(() => updateDoc(doc(db, "runs", run.id), {status:"cancelled", completedAt:Date.now()}), "Run cancelled"); break;
    case "delete-run": if(run) await write(() => deleteDoc(doc(db, "runs", run.id)), "Run deleted"); break;
    case "enable-alerts": enableAlerts(); break;
    case "test-alert": await write(async () => { const res = await httpsCallable(fns, "sendTestAlert")(); return res; }, "Test alert sent. Close the app to see it arrive."); break;
    case "fav-new": favSheet(null); break;
    case "fav-edit": favSheet(parseInt(el.dataset.i)); break;
    case "fav-del": { const f = favourites(); f.splice(parseInt(el.dataset.i), 1); await write(() => updateDoc(memberRef(), {favourites:f}), "Deleted"); break; }
    case "copy-invite": copy(`${APP_URL}#join=${S.invite}`, "Invite link copied"); break;
    case "new-invite": await write(() => updateDoc(doc(db, "secrets", "invite"), {code:randomCode()}), "New invite link made. Old links no longer work"); break;
    case "remove-member": { const u = el.dataset.uid; if(await write(() => deleteDoc(doc(db, "members", u)))) await write(() => updateDoc(doc(db, "secrets", "invite"), {code:randomCode()}), "Removed. Your invite link has changed"); break; }
    case "leave": { const u = S.uid; await write(async () => { await deleteDoc(doc(db, "pushSubs", u)).catch(() => {}); await deleteDoc(memberRef()); }, "You've left the team"); break; }
  }
});
document.addEventListener("change", e => {
  const t = e.target;
  if(t.id === "me-sound"){ S.sound = t.checked; LS.set("sound", S.sound); if(S.sound) chime(); }
  if(t.id === "me-notify") write(() => updateDoc(memberRef(), {notifyAnswers:t.checked}), t.checked ? "You'll be alerted as people answer" : "No alerts for answers");
  if(t.name === "pick"){ const n = $("#newOrder"); if(n) n.hidden = t.value !== "new"; }
  if(t.id === "o-drink"){ $("#o-other-wrap").hidden = t.value !== "Other"; if(BLACK.has(t.value)) $("#o-milk").value = "No milk"; }
});
document.addEventListener("toggle", e => { const d = e.target; if(d.matches && d.matches("details.run")){ d.open ? S.openDetails.add(d.dataset.id) : S.openDetails.delete(d.dataset.id); } }, true);
document.addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.target, btn = f.querySelector('button[type="submit"]');
  const busy = on => { if(btn) btn.disabled = on; };
  if(f.id === "signinForm"){
    const email = $("#si-email").value.trim();
    busy(true); S.linkError = "";
    try{ await sendSignInLinkToEmail(auth, email, {url:APP_URL, handleCodeInApp:true}); LS.set("email", email); LS.set("awaitingLink", Date.now()); S.stage = "check-email"; }
    catch(err){ S.linkError = errMsg(err); }
    busy(false); schedule();
  }
  if(f.id === "pasteForm"){
    const link = $("#paste-link").value.trim();
    if(!isSignInWithEmailLink(auth, link)){ S.linkError = "That isn't a Coffee Please sign-in link. Copy the whole link from the email."; return schedule(); }
    busy(true); await completeLink(LS.get("email", ""), link); busy(false);
  }
  if(f.id === "linkEmailForm"){ busy(true); await completeLink($("#le-email").value.trim(), location.href); busy(false); }
  if(f.id === "createForm"){
    const name = $("#ct-name").value.trim().slice(0, 40); if(!name) return;
    busy(true);
    const code = randomCode(), b = writeBatch(db), now = Date.now();
    b.set(doc(db, "config", "team"), {owner:S.uid, createdAt:now});
    b.set(doc(db, "secrets", "invite"), {code});
    b.set(memberRef(), {name, code, joinedAt:now, favourites:[], notifyAnswers:true});
    await write(() => b.commit(), "Team created. Next, turn on alerts and copy your invite link");
    busy(false); S.tab = "me";
  }
  if(f.id === "joinForm"){
    const name = $("#jn-name").value.trim().slice(0, 40); const code = $("#jn-code").value.trim().replace(/^.*#join=/, "");
    if(!name || !code) return;
    busy(true); S.linkError = "";
    try{ await setDoc(memberRef(), {name, code, joinedAt:Date.now(), favourites:[], notifyAnswers:true}); LS.del("invite"); history.replaceState(null, "", APP_URL); toast("You're on the team"); }
    catch(err){ S.linkError = err.code === "permission-denied" ? "That invite code isn't valid. Ask for a new invite link." : errMsg(err); schedule(); }
    busy(false);
  }
  if(f.id === "nameForm"){ const name = $("#me-name").value.trim().slice(0, 40); if(name) await write(() => updateDoc(memberRef(), {name}), "Name saved"); }
  if(f.id === "startForm"){
    const cafe = $("#st-cafe").value.trim().slice(0, 60);
    const mins = parseInt(f.querySelector('input[name="st-mins"]:checked')?.value || "10");
    const invited = [...f.querySelectorAll('input[name="st-who"]:checked')].map(i => i.value);
    if(!invited.length) return toast("Pick at least one person to ask");
    LS.set("lastCafe", cafe); busy(true);
    const now = Date.now(), ref = doc(collection(db, "runs"));
    if(await write(() => setDoc(ref, {by:S.uid, cafe, status:"open", createdAt:now, closesAt:now + mins * 60000, invited, reminded:false}), `Asked ${invited.length} ${invited.length === 1 ? "person" : "people"}`)){ closeSheet(); S.tab = "run"; }
    busy(false);
  }
  if(f.id === "orderForm"){
    const runId = f.dataset.run, pick = f.querySelector('input[name="pick"]:checked')?.value, favs = favourites();
    let order;
    if(pick && pick !== "new") order = favs[parseInt(pick)];
    else { order = readOrderForm(); if($("#o-save")?.checked){ const nf = [...favs, {...order, label:order.label || (favs.length ? "Order " + (favs.length + 1) : "My usual")}].slice(-12); await write(() => updateDoc(memberRef(), {favourites:nf})); } }
    if(!order) return;
    busy(true);
    if(await write(() => setAnswer(runId, {answer:"yes", order:cleanOrder(order)}), "Order sent")) closeSheet();
    busy(false);
  }
  if(f.id === "favForm"){
    const o = readOrderForm(), favs = favourites(), i = f.dataset.i === "" ? -1 : parseInt(f.dataset.i);
    if(!o.label) o.label = i >= 0 ? (favs[i]?.label || "My usual") : (favs.length ? "Order " + (favs.length + 1) : "My usual");
    if(i >= 0) favs[i] = o; else favs.push(o);
    if(await write(() => updateDoc(memberRef(), {favourites:favs.slice(-12)}), "Saved")) closeSheet();
  }
});

/* ---------- start ---------- */
async function boot(){
  if(!CONFIGURED){ S.stage = "setup"; return schedule(); }
  const code = inviteFromHash(); if(code) LS.set("invite", code);
  const run = new URLSearchParams(location.hash.slice(1)).get("run"); if(run) S.pendingRun = run;
  initFirebase();
  swReady = registerSW();
  const link = location.href;
  let handledLink = false;
  if(isSignInWithEmailLink(auth, link)){
    handledLink = true;
    if(isIOS && !isStandalone()){ S.stage = "link-ios"; schedule(); }
    else { const em = LS.get("email", ""); if(em) completeLink(em, link); else { S.stage = "link-email"; schedule(); } }
  }
  onAuthStateChanged(auth, user => {
    stopAll(); stopTeamData();
    S.uid = null; S.me = null; S.team = null; S.teamLoaded = S.meLoaded = false; S.invite = null;
    if(user){ S.stage = "loading"; onSignedIn(user); }
    else if(!(handledLink && ["link-ios","link-email"].includes(S.stage))){
      const waiting = S.stage === "check-email" || Date.now() - LS.get("awaitingLink", 0) < 3600e3;
      S.stage = (isIOS && !isStandalone() && !LS.get("skipInstall", false)) ? "install" : (waiting ? "check-email" : "signin");
    }
    schedule();
  });
}
boot();
