"use strict";

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
}
