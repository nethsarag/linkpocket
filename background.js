import { signInFlow } from "./auth.js";
import { currentUser, listFolders, listNotes } from "./api.js";
import { notifyNewNote } from "./notify.js";

// The popup closes when the Google sign-in window opens, so the flow runs here.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return; // only our own extension pages
  if (msg?.type !== "lp:signin") return;
  signInFlow(!!msg.interactive)
    .then((user) => sendResponse({ ok: true, user }))
    .catch((e) => sendResponse({ ok: false, error: e.message || "Sign-in failed." }));
  return true; // keep the channel open for the async response
});

// ---- New-note notifications for notes added by other people (shared folders) ----
const ALARM = "lp-check-notes";
const SEEN_KEY = "lp_seen_notes"; // { [folderId]: [noteId, ...] } notes we have already accounted for

function ensureAlarm() {
  chrome.alarms.get(ALARM, (a) => {
    if (!a) chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
  });
}
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
ensureAlarm();

let checking = false;
async function checkForNewNotes() {
  if (checking) return;
  checking = true;
  try {
    const me = await currentUser();
    if (!me) return; // signed out: nothing to watch
    const stored = (await chrome.storage.local.get(SEEN_KEY))[SEEN_KEY];
    const seen = stored || {};
    const next = {};
    for (const f of await listFolders(me.email)) {
      const notes = await listNotes(f.id);
      next[f.id] = notes.map((n) => n.id);
      if (!stored || !(f.id in seen)) continue; // first look at a folder: record it, don't announce old notes
      for (const n of notes) {
        if (!seen[f.id].includes(n.id) && n.updatedBy !== me.email) notifyNewNote(f.name, n, n.updatedBy);
      }
    }
    await chrome.storage.local.set({ [SEEN_KEY]: next });
  } catch {
    // Offline, expired session or rate limit: try again on the next tick.
  } finally {
    checking = false;
  }
}
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) checkForNewNotes();
});
