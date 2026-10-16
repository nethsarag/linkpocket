import { CONFIG } from "./config.js";

export class AuthError extends Error {}

const SESSION_KEY = "lp_session";
const SIGNED_OUT_KEY = "lp_signed_out";

// Tokens live in chrome.storage.session: memory only, cleared when the browser closes.
async function getSession() {
  const o = await chrome.storage.session.get(SESSION_KEY);
  return o[SESSION_KEY] || null;
}
async function setSession(s) {
  await chrome.storage.session.set({ [SESSION_KEY]: s });
}
const publicUser = (s) => ({ uid: s.uid, email: s.email, name: s.name });

async function exchangeGoogleToken(accessToken) {
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${CONFIG.FIREBASE_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        postBody: `access_token=${encodeURIComponent(accessToken)}&providerId=google.com`,
        requestUri: "http://localhost",
        returnSecureToken: true,
        returnIdpCredential: false,
      }),
    }
  );
  if (!r.ok) throw new AuthError("Google sign-in worked, but LinkPocket could not verify it. Try again.");
  const d = await r.json();
  return {
    idToken: d.idToken,
    refreshToken: d.refreshToken,
    expiresAt: Date.now() + (Number(d.expiresIn) - 60) * 1000,
    uid: d.localId,
    email: String(d.email || "").toLowerCase(),
    name: d.displayName || "",
  };
}

// Runs in the service worker so it survives the popup closing while the Google window is open.
export async function signInFlow(interactive) {
  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: CONFIG.OAUTH_CLIENT_ID,
    response_type: "token",
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: "openid email profile",
    prompt: interactive ? "select_account" : "none",
    state,
  });
  let resp;
  try {
    resp = await chrome.identity.launchWebAuthFlow({
      url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
      interactive,
    });
  } catch {
    throw new AuthError(interactive ? "Sign-in was cancelled." : "");
  }
  const hash = new URLSearchParams(new URL(resp).hash.slice(1));
  if (hash.get("state") !== state) throw new AuthError("Sign-in could not be verified. Try again.");
  const accessToken = hash.get("access_token");
  if (!accessToken) throw new AuthError(interactive ? "Google did not return a sign-in token." : "");
  const session = await exchangeGoogleToken(accessToken);
  await setSession(session);
  await chrome.storage.local.remove(SIGNED_OUT_KEY);
  return publicUser(session);
}

export async function signOut() {
  await chrome.storage.session.remove(SESSION_KEY);
  await chrome.storage.local.set({ [SIGNED_OUT_KEY]: true });
}

export async function wasSignedOut() {
  const o = await chrome.storage.local.get(SIGNED_OUT_KEY);
  return !!o[SIGNED_OUT_KEY];
}

export async function currentUser() {
  const s = await getSession();
  return s ? publicUser(s) : null;
}

// Zero trust: every request carries a fresh, short-lived Firebase ID token.
export async function getToken() {
  const s = await getSession();
  if (!s) throw new AuthError("Please sign in.");
  if (Date.now() < s.expiresAt) return s.idToken;
  const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${CONFIG.FIREBASE_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: s.refreshToken }),
  });
  if (!r.ok) {
    await chrome.storage.session.remove(SESSION_KEY);
    throw new AuthError("Your session expired. Please sign in again.");
  }
  const d = await r.json();
  await setSession({
    ...s,
    idToken: d.id_token,
    refreshToken: d.refresh_token || s.refreshToken,
    expiresAt: Date.now() + (Number(d.expires_in) - 60) * 1000,
  });
  return d.id_token;
}

export async function dropSession() {
  await chrome.storage.session.remove(SESSION_KEY);
}
