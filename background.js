import { signInFlow } from "./auth.js";

// The popup closes when the Google sign-in window opens, so the flow runs here.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return; // only our own extension pages
  if (msg?.type !== "lp:signin") return;
  signInFlow(!!msg.interactive)
    .then((user) => sendResponse({ ok: true, user }))
    .catch((e) => sendResponse({ ok: false, error: e.message || "Sign-in failed." }));
  return true; // keep the channel open for the async response
});
