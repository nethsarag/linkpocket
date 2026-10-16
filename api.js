import { CONFIG } from "./config.js";
import { AuthError, getToken, dropSession } from "./auth.js";

export { AuthError, signOut, currentUser, wasSignedOut } from "./auth.js";

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const FS = `https://firestore.googleapis.com/v1/projects/${CONFIG.PROJECT_ID}/databases/(default)/documents`;
export const SLOTS = ["n1", "n2", "n3", "n4", "n5"]; // free plan: 5 notes per folder, enforced by rules

const MESSAGES = {
  403: "You don't have permission to do that.",
  404: "That item no longer exists.",
  409: "Someone just changed this. Try again.",
  429: "Too many requests. Wait a moment and try again.",
};

// ---- Firestore value codec ----
const enc = (v) =>
  Array.isArray(v)
    ? { arrayValue: { values: v.map(enc) } }
    : typeof v === "string"
    ? { stringValue: v }
    : typeof v === "number"
    ? { integerValue: String(v) }
    : typeof v === "boolean"
    ? { booleanValue: v }
    : { nullValue: null };

const dec = (v) =>
  "stringValue" in v
    ? v.stringValue
    : "arrayValue" in v
    ? (v.arrayValue.values || []).map(dec)
    : "integerValue" in v
    ? Number(v.integerValue)
    : "booleanValue" in v
    ? v.booleanValue
    : null;

const encFields = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const decDoc = (d) => ({
  id: d.name.split("/").pop(),
  ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, dec(v)])),
});

// ---- Authenticated request: no request is trusted without a valid token ----
async function fs(path, { method = "GET", body, query = "" } = {}) {
  const token = await getToken();
  let r;
  try {
    r = await fetch(`${FS}${path}${query ? "?" + query : ""}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "You're offline. Check your connection.");
  }
  if (r.status === 401) {
    await dropSession();
    throw new AuthError("Your session expired. Please sign in again.");
  }
  if (!r.ok) throw new ApiError(r.status, MESSAGES[r.status] || "Something went wrong. Try again.");
  return r.status === 204 ? null : r.json();
}

// ---- Sign in (runs in the service worker) ----
export async function signIn(interactive) {
  const res = await chrome.runtime.sendMessage({ type: "lp:signin", interactive });
  if (!res?.ok) throw new AuthError(res?.error || "Sign-in failed.");
  return res.user;
}

// ---- Folders ----
export async function listFolders(email) {
  const res = await fs(":runQuery", {
    method: "POST",
    body: {
      structuredQuery: {
        from: [{ collectionId: "folders" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "memberEmails" },
            op: "ARRAY_CONTAINS",
            value: { stringValue: email },
          },
        },
      },
    },
  });
  return res.filter((r) => r.document).map((r) => decDoc(r.document));
}

export async function createFolder(name, me) {
  const doc = await fs("/folders", {
    method: "POST",
    body: {
      fields: encFields({
        name,
        ownerUid: me.uid,
        ownerEmail: me.email,
        memberEmails: [me.email],
        editorEmails: [],
        createdAt: new Date().toISOString(),
      }),
    },
  });
  return decDoc(doc);
}

export async function updateFolder(id, fields) {
  const mask = Object.keys(fields)
    .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join("&");
  await fs(`/folders/${id}`, { method: "PATCH", query: mask, body: { fields: encFields(fields) } });
}

export async function deleteFolder(id) {
  const notes = await listNotes(id);
  for (const n of notes) await fs(`/folders/${id}/notes/${n.id}`, { method: "DELETE" });
  await fs(`/folders/${id}`, { method: "DELETE" });
}

// ---- Notes ----
export async function listNotes(folderId) {
  const res = await fs(`/folders/${folderId}/notes`, { query: "pageSize=10" });
  return (res.documents || []).map(decDoc).sort((a, b) => a.id.localeCompare(b.id));
}

export async function saveNote(folderId, slot, { title, text }, me, isNew) {
  await fs(`/folders/${folderId}/notes/${slot}`, {
    method: "PATCH",
    query: isNew ? "currentDocument.exists=false" : "",
    body: {
      fields: encFields({ title, text, updatedBy: me.email, updatedAt: new Date().toISOString() }),
    },
  });
}

export async function deleteNote(folderId, slot) {
  await fs(`/folders/${folderId}/notes/${slot}`, { method: "DELETE" });
}
