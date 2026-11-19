# LinkPocket (Chromium extension | Mozilla In Production, v0.2)

Save links and ideas in folders, and share them with friends and teammates.
No build step: Manifest V3, plain JavaScript modules, Firebase Auth + Firestore through their REST APIs.

## Setup (about 10 minutes)

1. **Create a Firebase project** at console.firebase.google.com.
2. **Authentication → Sign-in method → Google → Enable.** Open "Web SDK configuration" and copy the **Web client ID**.
3. **Firestore Database → Create database** (production mode). Open the **Rules** tab and paste in `firestore.rules`, then Publish.
4. **Project settings → General:** copy the **Web API key** and the **Project ID**.
5. Put all three values in `config.js`.
6. **Load the extension:** open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, select this folder. Copy the extension **ID** shown on the card.
7. **Allow the sign-in redirect:** in Google Cloud Console → APIs & Services → Credentials, open the Web client from step 2 and add this under *Authorized redirect URIs*:
   `https://<EXTENSION_ID>.chromiumapp.org/`
8. Click the LinkPocket icon and sign in.

**Keep the extension ID stable.** An unpacked extension's ID can change on another machine. Before publishing, add a `"key"` to `manifest.json` (Chrome Web Store dashboard → Package → public key) so the redirect URI never changes.

## How it works

| Feature | Where |
|---|---|
| Google login | `auth.js` runs `launchWebAuthFlow` inside the service worker (`background.js`), because the popup closes when Google's window opens. Works in Chrome, Edge, Brave, Opera. |
| Folders, notes, sharing | `api.js` (Firestore REST) and `popup.js` |
| Notes with title + text, links detected | Links become tappable in the note view. Copy buttons copy the text only, never the title. |
| Add current tab | Fills the note with the page title and URL (uses `activeTab`, no broad tab access). |
| Sharing by email | Owner adds an email and picks View only or Can edit. The folder appears when that person signs in with that Google email. |
| New-note notifications | `notify.js` shows a system notification when you add a note (from the popup) and when someone else adds one to a shared folder (`background.js` checks every minute via `chrome.alarms`). First check after sign-in only records existing notes, so old notes never trigger alerts. |
| Offline mode | Everything you've opened is saved on the device and readable offline. Edits made offline (new/edited/deleted notes, folders, sharing changes) go into a durable queue and sync automatically when you're back online: when the browser reports it, when the popup opens, or via the background check. A small banner shows "Offline" and how many changes are waiting. Code: `api.js` (cache + queue), `background.js` (background sync). |
| No plan limits | Unlimited folders, notes per folder, and people per folder. The old 5-note / 5-person caps are gone from the UI and from `firestore.rules`. |

Data model: `folders/{id}` with `ownerUid, ownerEmail, memberEmails[], editorEmails[]`, and `folders/{id}/notes/{id}` (`title, text, updatedBy, updatedAt, createdAt`).
Folder and note ids are random, generated on the device, which is what lets them be created offline. Existing notes (`n1`–`n5`) keep working.

## Upgrading from v0.1

**Republish `firestore.rules`** (Firebase console → Firestore → Rules → paste → Publish). Without this the server still enforces the old 5-note / 5-person limits and rejects new notes.

## Offline details

- Sign in once while online; after that the session is kept on the device and the extension opens and works with no connection. First-ever sign-in needs internet.
- A folder's notes are available offline once they've been loaded once while online (the popup and background check do this automatically).
- If two people edit the same note while one is offline, the last change to reach the server wins.
- If a queued change is refused when it syncs (for example your access was removed), it is dropped and you get a notice.
- Signing out deletes everything stored on the device, including unsynced changes (you're warned first).

## Zero Trust: what is in place

- **Never trust the client.** Every permission and limit is checked by Firestore rules on every request. The popup only hides buttons.
- **Verify explicitly.** Each request carries a short-lived Firebase ID token (refreshed about hourly). Rules require a verified Google email.
- **Least privilege.** Viewers can read only. Editors can change notes only. Only the owner can share, rename, or delete a folder, and ownership can't be transferred or forged. Members can only remove themselves.
- **Default deny.** Anything not explicitly allowed in the rules is refused.
- **Minimal extension permissions:** `identity`, `storage`, `unlimitedStorage` (offline copies), `activeTab`, `notifications`, `alarms`, and three Google API hosts. No content scripts, no `<all_urls>`.
- **Strict CSP:** scripts and styles only from the extension itself, network only to the three Firebase endpoints.
- **No injection path:** the UI never uses `innerHTML`; note text is always inserted as text, and only `http(s)` links become clickable.
- **Tokens stay in memory:** kept in `chrome.storage.session`, wiped when the browser closes. Signing out blocks silent re-login.

## Known limits and next steps

- Invites work for any Google email, including people who haven't installed LinkPocket yet. This avoids letting users look up who has an account.
- Timestamps (`createdAt`, `updatedAt`) come from the client. Switch to server timestamps before building anything that depends on them.
- The popup refreshes when it opens or you navigate. Shared-note notifications use a 1-minute background check, so they can arrive up to about a minute late.
- Add Firebase **App Check** and **audit logging** (Cloud Functions) before launch.
- For paid plans, move limits into Cloud Functions plus custom claims so the plan itself is also server-controlled.
- Firefox is a separate port: `chrome.identity.launchWebAuthFlow` exists there, but the manifest needs `browser_specific_settings` and a background script instead of a service worker.
