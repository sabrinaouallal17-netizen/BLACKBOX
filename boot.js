"use strict";

/* ---------- Installable app (PWA) ---------- */
let installPrompt = null;
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  if (user) render();
});
window.addEventListener("appinstalled", () => { installPrompt = null; toast("BLACKBOX is installed"); if (user) render(); });
async function installApp() {
  if (!installPrompt) return toast("Use your browser's install option (address bar or Share menu).");
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => null);
  installPrompt = null;
  render();
}
// Offline support and installability for the hosted (GitHub Pages) edition only.
if (!ARTIFACT && "serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost") && !USE_EMULATOR) {
  navigator.serviceWorker.register("sw.js").catch((e) => console.warn("BLACKBOX: offline support unavailable", e));
}

/* ---------- Boot ---------- */
document.querySelectorAll("[data-icon]").forEach((el) => {
  if (!el.innerHTML) el.insertAdjacentHTML("afterbegin", icon(el.dataset.icon, el.dataset.icon === "home" ? 20 : 18));
});
upgradeSelects(document);

if (!FB_CONFIG || typeof firebase === "undefined") {
  if (typeof firebase === "undefined") console.error("BLACKBOX: Firebase SDK failed to load.");
  showScreen("setup-screen");
} else {
  if (ARTIFACT) BB.onNames(scheduleRender);
  firebase.initializeApp(FB_CONFIG);
  auth = firebase.auth();
  db = firebase.firestore();
  if (USE_EMULATOR) {
    auth.useEmulator("http://127.0.0.1:9099", { disableWarnings: true });
    db.useEmulator("127.0.0.1", 8080);
  }
  auth.onAuthStateChanged(onAuth);
  // Back from a Google sign-in redirect: show any error on the sign-in screen.
  if (!ARTIFACT) auth.getRedirectResult?.().catch((err) => { console.error("BLACKBOX: google redirect", err); authError("#auth-error", friendlyError(err)); });
}
