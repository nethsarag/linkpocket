# LinkPocket (Chromium extension | Mozilla In Production, v0.1)

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
| Free plan limits | 5 notes per folder, 5 people per folder (owner counts as one). Enforced in `firestore.rules`, not just the UI. |

Data model: `folders/{id}` with `ownerUid, ownerEmail, memberEmails[], editorEmails[]`, and `folders/{id}/notes/n1…n5`.
Fixed note ids `n1`–`n5` are what make the 5-note limit impossible to bypass from a modified client.

## Zero Trust: what is in place

- **Never trust the client.** Every permission and limit is checked by Firestore rules on every request. The popup only hides buttons.
- **Verify explicitly.** Each request carries a short-lived Firebase ID token (refreshed about hourly). Rules require a verified Google email.
- **Least privilege.** Viewers can read only. Editors can change notes only. Only the owner can share, rename, or delete a folder, and ownership can't be transferred or forged. Members can only remove themselves.
- **Default deny.** Anything not explicitly allowed in the rules is refused.
- **Minimal extension permissions:** `identity`, `storage`, `activeTab`, and three Google API hosts. No content scripts, no `<all_urls>`.
- **Strict CSP:** scripts and styles only from the extension itself, network only to the three Firebase endpoints.
- **No injection path:** the UI never uses `innerHTML`; note text is always inserted as text, and only `http(s)` links become clickable.
- **Tokens stay in memory:** kept in `chrome.storage.session`, wiped when the browser closes. Signing out blocks silent re-login.

## Known limits and next steps

- Invites work for any Google email, including people who haven't installed LinkPocket yet. This avoids letting users look up who has an account.
- Timestamps (`createdAt`, `updatedAt`) come from the client. Switch to server timestamps before building anything that depends on them.
- Updates appear when the popup opens or you navigate. Live updates would need a listener or polling.
- Add Firebase **App Check** and **audit logging** (Cloud Functions) before launch.
- For paid plans, move limits into Cloud Functions plus custom claims so the plan itself is also server-controlled.
- Firefox is a separate port: `chrome.identity.launchWebAuthFlow` exists there, but the manifest needs `browser_specific_settings` and a background script instead of a service worker.
