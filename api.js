import { CONFIG } from "./config.js";
import { AuthError, getToken, dropSession, currentUser } from "./auth.js";

export { AuthError, signOut, currentUser, wasSignedOut } from "./auth.js";

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const FS = `https://firestore.googleapis.com/v1/projects/${CONFIG.PROJECT_ID}/databases/(default)/documents`;
const DOC_ROOT = `projects/${CONFIG.PROJECT_ID}/databases/(default)/documents`;

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

// Random Firestore document ids made on the device, so folders and notes can be created offline
// and keep the same id once they sync.
const ID_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
export function newId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => ID_CHARS[b % 62]).join("");
}

// ---- Authenticated request: no request is trusted without a valid token ----
async function fs(path, { method = "GET", body, query = "" } = {}, retried = false) {
  let token;
  try {
    token = await getToken(retried); // on the retry, force a fresh token
  } catch (e) {
    if (e instanceof AuthError) throw e;
    throw new ApiError(0, "You're offline. Check your connection."); // couldn't reach the token service
  }
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
    // The cached token may have just expired or been rotated: refresh once and retry before giving up.
    if (!retried) return fs(path, { method, body, query }, true);
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

/* =====================================================================================
   Offline support

   Reads:  every successful read is saved on the device (a snapshot of the server).
           When the network is unavailable, the snapshot is shown instead.
   Writes: every change is first saved in a durable on-device queue ("outbox"), then sent.
           If the network is down the change stays queued and is sent later (when the popup
           next opens, when the browser comes back online, or by the background check).
           The queue is replayed over the snapshot, so offline edits show up immediately.
   All queued operations are idempotent (they set or delete a document by id), so a retry
   after a lost response is harmless.
   ===================================================================================== */

const OPS_KEY = "lp_ops";
const DROPPED_KEY = "lp_sync_dropped";
const FOLDERS_CACHE = "lp_cache_folders";
const notesCache = (fid) => `lp_cache_notes_${fid}`;

let offline = false; // last network attempt in this context failed
export const isOffline = () => offline;

const store = {
  get: async (k) => (await chrome.storage.local.get(k))[k],
  set: (k, v) => chrome.storage.local.set({ [k]: v }),
  remove: (k) => chrome.storage.local.remove(k),
};

// Retryable failures: no network, throttling, server trouble. Anything else is a real refusal.
const isTransient = (e) =>
  !(e instanceof AuthError) && (!(e instanceof ApiError) || e.status === 0 || e.status === 429 || e.status >= 500);

// The popup and the background worker share the queue, so every change to it is serialized by a lock.
const withLock = (name, fn) => navigator.locks.request(name, fn);
const readOps = async () => (await store.get(OPS_KEY)) || [];
const mutateOps = (fn) =>
  withLock("lp-ops", async () => {
    const next = await fn(await readOps());
    await store.set(OPS_KEY, next);
    return next;
  });

async function enqueue(op) {
  const me = await currentUser();
  if (!me) throw new AuthError("Please sign in.");
  const full = { id: crypto.randomUUID(), uid: me.uid, at: Date.now(), ...op };
  await mutateOps((ops) => [...ops, full]);
  return full;
}

async function noteDropped(n) {
  await withLock("lp-ops", async () => store.set(DROPPED_KEY, ((await store.get(DROPPED_KEY)) || 0) + n));
}
// How many offline changes were refused by the server since the popup last asked (e.g. access was removed).
export async function takeDropped() {
  return withLock("lp-ops", async () => {
    const n = (await store.get(DROPPED_KEY)) || 0;
    if (n) await store.remove(DROPPED_KEY);
    return n;
  });
}

export async function syncInfo() {
  const me = await currentUser();
  const pending = me ? (await readOps()).filter((o) => o.uid === me.uid).length : 0;
  return { offline, pending };
}

// ---- Run one queued operation against Firestore ----
const folderFields = (f) =>
  encFields({
    name: f.name,
    ownerUid: f.ownerUid,
    ownerEmail: f.ownerEmail,
    memberEmails: f.memberEmails,
    editorEmails: f.editorEmails,
    createdAt: f.createdAt,
  });
const noteFields = (n) =>
  encFields({
    title: n.title,
    text: n.text,
    updatedBy: n.updatedBy,
    updatedAt: n.updatedAt,
    createdAt: n.createdAt,
  });
const gone = (p) =>
  p.catch((e) => {
    if (!(e instanceof ApiError && e.status === 404)) throw e; // already deleted is fine
  });

async function runOp(op) {
  switch (op.type) {
    case "createFolder":
      // PATCH on a new id creates the document; repeating it after a lost response just rewrites the same data.
      return void (await fs(`/folders/${op.folder.id}`, { method: "PATCH", body: { fields: folderFields(op.folder) } }));
    case "updateFolder": {
      const mask = Object.keys(op.fields)
        .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
        .join("&");
      return void (await fs(`/folders/${op.id}`, { method: "PATCH", query: mask, body: { fields: encFields(op.fields) } }));
    }
    case "deleteFolder": {
      const ids = (await fetchNotes(op.id)).map((n) => n.id);
      for (let i = 0; i < ids.length; i += 100) {
        const writes = ids.slice(i, i + 100).map((id) => ({ delete: `${DOC_ROOT}/folders/${op.id}/notes/${id}` }));
        await fs(":commit", { method: "POST", body: { writes } });
      }
      return void (await gone(fs(`/folders/${op.id}`, { method: "DELETE" })));
    }
    case "saveNote":
      return void (await fs(`/folders/${op.folderId}/notes/${op.note.id}`, { method: "PATCH", body: { fields: noteFields(op.note) } }));
    case "deleteNote":
      return void (await gone(fs(`/folders/${op.folderId}/notes/${op.noteId}`, { method: "DELETE" })));
  }
}

// ---- Send the queue, oldest first. Stops at the first retryable failure. ----
// Returns { pending, dropped } where dropped lists operations the server refused.
export function flush() {
  return withLock("lp-flush", async () => {
    const result = { pending: 0, dropped: [] };
    const me = await currentUser();
    if (!me) return result;
    for (;;) {
      const mine = (await readOps()).filter((o) => o.uid === me.uid);
      const op = mine[0];
      if (!op) return result;
      try {
        await runOp(op);
        offline = false;
        await mutateOps((ops) => ops.filter((o) => o.id !== op.id));
      } catch (e) {
        if (e instanceof AuthError) throw e; // queue is kept; it sends after the next sign-in
        if (isTransient(e)) {
          offline = true;
          result.pending = mine.length;
          return result;
        }
        result.dropped.push({ id: op.id, status: e.status, message: e.message });
        await mutateOps((ops) => ops.filter((o) => o.id !== op.id));
        await noteDropped(1);
      }
    }
  });
}

async function write(op) {
  const queued = await enqueue(op); // saved on the device before anything touches the network
  const r = await flush();
  const refused = r.dropped.find((d) => d.id === queued.id);
  if (refused) throw new ApiError(refused.status, refused.message);
}

// ---- Replay queued changes over the saved snapshot ----
const byAge = (a, b) =>
  (a.createdAt || a.updatedAt || "").localeCompare(b.createdAt || b.updatedAt || "") || a.id.localeCompare(b.id);

function overlayFolders(list, ops) {
  let out = [...list];
  for (const o of ops) {
    if (o.type === "createFolder") {
      if (!out.some((f) => f.id === o.folder.id)) out.push({ ...o.folder });
    } else if (o.type === "updateFolder") out = out.map((f) => (f.id === o.id ? { ...f, ...o.fields } : f));
    else if (o.type === "deleteFolder") out = out.filter((f) => f.id !== o.id);
  }
  return out;
}
function overlayNotes(fid, list, ops) {
  let out = [...list];
  for (const o of ops) {
    if (o.type === "saveNote" && o.folderId === fid) {
      const i = out.findIndex((n) => n.id === o.note.id);
      if (i >= 0) out[i] = { ...o.note };
      else out.push({ ...o.note });
    } else if (o.type === "deleteNote" && o.folderId === fid) out = out.filter((n) => n.id !== o.noteId);
  }
  return out.sort(byAge);
}

async function myOps() {
  const me = await currentUser();
  if (!me) throw new AuthError("Please sign in.");
  return { me, ops: (await readOps()).filter((o) => o.uid === me.uid) };
}
async function readSnapshot(key, uid) {
  const v = await store.get(key);
  return v && v.uid === uid ? v : null;
}
const NOT_SAVED = "You're offline, and this isn't saved on this device yet. Open it once while online.";

// ---- Folders ----
async function fetchFolders(email) {
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

export async function listFolders(email) {
  const { me } = await myOps();
  const { pending } = await flush(); // send offline changes first so the fresh read includes them
  if (!pending) {
    try {
      const folders = await fetchFolders(email);
      offline = false;
      const prev = await readSnapshot(FOLDERS_CACHE, me.uid);
      const keep = new Set(folders.map((f) => f.id));
      const stale = (prev?.folders || []).filter((f) => !keep.has(f.id)).map((f) => notesCache(f.id));
      if (stale.length) await chrome.storage.local.remove(stale);
      await store.set(FOLDERS_CACHE, { uid: me.uid, folders });
      return folders;
    } catch (e) {
      if (!isTransient(e)) throw e;
      offline = true;
    }
  }
  const { ops } = await myOps();
  const snap = await readSnapshot(FOLDERS_CACHE, me.uid);
  if (!snap && !ops.length) throw new ApiError(0, "You're offline, and nothing is saved on this device yet.");
  return overlayFolders(snap?.folders || [], ops);
}

export async function createFolder(name, me) {
  const folder = {
    id: newId(),
    name,
    ownerUid: me.uid,
    ownerEmail: me.email,
    memberEmails: [me.email],
    editorEmails: [],
    createdAt: new Date().toISOString(),
  };
  await write({ type: "createFolder", folder });
  return folder;
}

export async function updateFolder(id, fields) {
  await write({ type: "updateFolder", id, fields });
}

export async function deleteFolder(id) {
  await write({ type: "deleteFolder", id });
}

// ---- Notes (no cap: any number per folder) ----
async function fetchNotes(folderId) {
  const out = [];
  let token = "";
  do {
    const res = await fs(`/folders/${folderId}/notes`, {
      query: `pageSize=300${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`,
    });
    out.push(...(res.documents || []).map(decDoc));
    token = res.nextPageToken || "";
  } while (token);
  return out.sort(byAge);
}

export async function listNotes(folderId) {
  const { me } = await myOps();
  const { pending } = await flush();
  if (!pending) {
    try {
      const notes = await fetchNotes(folderId);
      offline = false;
      await store.set(notesCache(folderId), { uid: me.uid, notes });
      return notes;
    } catch (e) {
      if (!isTransient(e)) throw e;
      offline = true;
    }
  }
  const { ops } = await myOps();
  const snap = await readSnapshot(notesCache(folderId), me.uid);
  const touched = ops.some((o) => o.folderId === folderId || o.folder?.id === folderId);
  if (!snap && !touched) throw new ApiError(0, NOT_SAVED);
  return overlayNotes(folderId, snap?.notes || [], ops);
}

// Save the notes of every folder on the device so they can be read offline. Stops quietly when offline.
export async function prefetchNotes(folders) {
  for (const f of folders) {
    try {
      await listNotes(f.id);
    } catch {
      return;
    }
  }
}

// note: { id, title, text, createdAt }. Returns the saved note.
export async function saveNote(folderId, { id, title, text, createdAt }, me) {
  const note = { id, title, text, createdAt, updatedBy: me.email, updatedAt: new Date().toISOString() };
  await write({ type: "saveNote", folderId, note });
  return note;
}

export async function deleteNote(folderId, noteId) {
  await write({ type: "deleteNote", folderId, noteId });
}
