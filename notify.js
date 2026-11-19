// New-note notifications. Used by the popup (your own notes) and the service worker (notes added by others).
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function notifyNewNote(folderName, note, byEmail, byMe = false) {
  const firstLine = (note.text || "").trim().split("\n")[0];
  const label = (note.title || "").trim() || firstLine || "Untitled note";
  chrome.notifications.create(`lp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: clip(`New note in ${folderName}`, 60),
    message: clip(label, 120),
    contextMessage: byMe ? "You added this note" : `Added by ${byEmail || "a teammate"}`,
  });
}
