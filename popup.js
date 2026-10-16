import * as api from "./api.js";

const app = document.getElementById("app");
const toastEl = document.getElementById("toast");
const LIMITS = { notes: 5, people: 5 }; // free plan (also enforced server-side by firestore.rules)
const TILES = ["#007aff", "#34c759", "#ff9500", "#af52de", "#ff2d55", "#32ade6", "#ff3b30", "#5856d6"];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const S = { me: null, folders: [], folder: null, notes: [], anim: "", error: "", busy: false };

/* ---------- tiny DOM helpers (no innerHTML anywhere: note content can never become markup) ---------- */
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

const NS = "http://www.w3.org/2000/svg";
const PATHS = {
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  back: "M15 18l-6-6 6-6",
  next: "M9 18l6-6-6-6",
  copy: "M8 8h11v12H8zM5 16V4h11",
  share: "M10 12a4 4 0 100-8 4 4 0 000 8zM2 21c0-3.9 3.6-7 8-7 1.2 0 2.3.2 3.3.6M19 14v6M16 17h6",
  folder: "M3 7a2 2 0 012-2h4l2 2h7a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z",
  link: "M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  pencil: "M4 20l4-1 11-11-3-3L5 16zM14 6l3 3",
  tab: "M3 5h18v14H3zM3 9h18",
};
function icon(name, size = 20) {
  const s = document.createElementNS(NS, "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor",
    "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
  })) s.setAttribute(k, v);
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", PATHS[name]);
  s.append(p);
  return s;
}

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1900);
}

async function act(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof api.AuthError) {
      S.me = null;
      S.error = e.message;
      render();
      return;
    }
    toast(e.message || "Something went wrong.");
  }
}

/* ---------- link detection ---------- */
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
function findLinks(text) {
  return [...text.matchAll(URL_RE)].map((m) => ({ raw: m[0].replace(/[.,;:!?)\]}]+$/, ""), index: m.index }));
}
function safeHref(raw) {
  try {
    const u = new URL(/^www\./i.test(raw) ? "https://" + raw : raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}
function linkify(text) {
  const out = [];
  let last = 0;
  for (const { raw, index } of findLinks(text)) {
    if (index < last) continue;
    if (index > last) out.push(text.slice(last, index));
    const href = safeHref(raw);
    out.push(href ? h("a", { href, target: "_blank", rel: "noopener noreferrer", text: raw }) : raw);
    last = index + raw.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/* ---------- permissions ---------- */
const isOwner = (f) => f.ownerUid === S.me.uid;
const canEdit = (f) => f.ownerEmail === S.me.email || f.editorEmails.includes(S.me.email);
const roleLabel = (f) => (isOwner(f) ? "Owner" : canEdit(f) ? "Can edit" : "View only");
const preview = (t) => (t || "").replace(/\s+/g, " ").trim().slice(0, 90);
const tileColor = (id) => TILES[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % TILES.length];

function copyText(text) {
  navigator.clipboard.writeText(text).then(
    () => toast("Copied"),
    () => toast("Couldn't copy. Allow clipboard access and try again.")
  );
}

/* ---------- data ---------- */
async function loadFolders() {
  await act(async () => {
    S.folders = (await api.listFolders(S.me.email)).sort((a, b) => a.name.localeCompare(b.name));
    if (S.folder) S.folder = S.folders.find((f) => f.id === S.folder.id) || null;
  });
}
async function loadNotes() {
  await act(async () => {
    S.notes = await api.listNotes(S.folder.id);
  });
}

/* ---------- sheets ---------- */
function openSheet(build) {
  const overlay = h("div", { class: "overlay" });
  const sheet = h("div", { class: "sheet", role: "dialog", "aria-modal": "true" });
  overlay.append(sheet);
  const onKey = (e) => e.key === "Escape" && close();
  function close() {
    document.removeEventListener("keydown", onKey);
    sheet.classList.add("out");
    setTimeout(() => overlay.remove(), 180);
  }
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  build(sheet, close);
  document.body.append(overlay);
  return close;
}
const sbar = (left, title, right) =>
  h("div", { class: "sbar" }, left || h("span"), h("strong", { text: title }), h("span", { class: "r" }, right));
const textBtn = (label, onclick, bold) => h("button", { class: "text-btn" + (bold ? " bold" : ""), onclick, text: label });

function confirmSheet({ title, message, label, onConfirm }) {
  openSheet((sheet, close) => {
    sheet.replaceChildren(
      sbar(textBtn("Cancel", close), title),
      h("div", { class: "sheet-body" },
        h("p", { class: "sect-f", text: message }),
        h("div", { class: "sect" }, h("div", { class: "group" },
          h("button", { class: "row danger", onclick: async () => { close(); await act(onConfirm); }, text: label })
        ))
      )
    );
  });
}

function promptSheet({ title, placeholder, value = "", label, onSubmit }) {
  openSheet((sheet, close) => {
    const input = h("input", { class: "field", placeholder, value, maxlength: "60", "aria-label": title });
    const submit = async () => {
      const v = input.value.trim();
      if (!v) return toast("Enter a name first.");
      close();
      await act(() => onSubmit(v));
    };
    input.addEventListener("keydown", (e) => e.key === "Enter" && submit());
    sheet.replaceChildren(
      sbar(textBtn("Cancel", close), title, textBtn(label, submit, true)),
      h("div", { class: "sheet-body" }, h("div", { class: "sect" }, h("div", { class: "group" }, input)))
    );
    setTimeout(() => input.focus(), 50);
  });
}

/* ---------- segmented control ---------- */
function seg(options, value, onChange) {
  return h("div", { class: "seg", role: "group" },
    options.map(([v, label]) => h("button", { "aria-pressed": String(v === value), onclick: () => onChange(v), text: label }))
  );
}

/* ---------- screens ---------- */
function mount(screen) {
  if (S.anim) screen.classList.add(S.anim);
  S.anim = "";
  app.replaceChildren(screen);
}
const group = (title, rows, footer) =>
  h("section", { class: "sect" },
    title && h("h2", { class: "sect-h", text: title }),
    h("div", { class: "group" }, rows),
    footer && h("p", { class: "sect-f", text: footer })
  );

function renderLogin() {
  const btn = h("button", { class: "btn primary big", text: "Continue with Google" });
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    S.error = "";
    try {
      S.me = await api.signIn(true);
      await loadFolders();
    } catch (e) {
      S.error = e.message;
    }
    render();
  });
  mount(h("main", { class: "screen login" },
    h("img", { class: "logo", src: "icons/icon128.png", alt: "LinkPocket", width: 84, height: 84 }),
    h("h1", { text: "LinkPocket" }),
    h("p", { class: "tag", text: "Keep the links and ideas worth sharing." }),
    btn,
    S.error && h("p", { class: "err", text: S.error }),
    h("p", { class: "fine", text: "We use your Google account only to sign you in. Your folders stay private until you share them." })
  ));
}

function folderRow(f) {
  const mine = isOwner(f);
  const people = f.memberEmails.length;
  return h("button", { class: "row tile-row", onclick: () => openFolder(f) },
    h("span", { class: "tile" }, icon("folder", 18)),
    h("span", { class: "row-main" },
      h("span", { class: "t", text: f.name }),
      h("span", { class: "s", text: mine ? (people > 1 ? `Shared with ${people - 1}` : "Only you") : `From ${f.ownerEmail}` })
    ),
    !mine && h("span", { class: "trail", text: roleLabel(f) }),
    h("span", { class: "chev" }, icon("next", 18))
  );
}

function renderFolders() {
  const mine = S.folders.filter((f) => isOwner(f));
  const shared = S.folders.filter((f) => !isOwner(f));
  const screen = h("main", { class: "screen" },
    h("header", { class: "nav" }, h("span"), h("span"),
      h("span", { class: "nav-r" }, h("button", { class: "icon-btn", "aria-label": "New folder", onclick: newFolder }, icon("plus", 24)))),
    h("h1", { class: "large", text: "Folders" }),
    !S.folders.length && h("div", { class: "empty" },
      h("h2", { text: "No folders yet" }),
      h("p", { text: "Create a folder to start saving links and ideas." }),
      h("button", { class: "btn primary", onclick: newFolder, text: "New folder" })),
    mine.length ? group("My folders", mine.map(folderRow)) : null,
    shared.length ? group("Shared with me", shared.map(folderRow)) : null,
    h("div", { class: "acct" }, h("div", { text: S.me.email }),
      h("button", { onclick: async () => { await api.signOut(); S.me = null; S.folders = []; S.folder = null; S.error = ""; render(); }, text: "Sign out" }))
  );
  mount(screen);
  screen.querySelectorAll(".tile").forEach((t, i) => {
    const f = [...mine, ...shared][i];
    if (f) t.style.setProperty("background", tileColor(f.id));
  });
}

function noteRow(n) {
  return h("div", { class: "row note" },
    h("button", { class: "row-main", onclick: () => noteSheet(n) },
      h("span", { class: "t", text: n.title || "Untitled" }),
      h("span", { class: "s", text: preview(n.text) || "No text" })),
    h("button", { class: "icon-btn", "aria-label": `Copy text of ${n.title || "note"}`, onclick: () => copyText(n.text || "") }, icon("copy", 20))
  );
}

function freeSlot() {
  return api.SLOTS.find((id) => !S.notes.some((n) => n.id === id));
}

function renderFolder() {
  const f = S.folder;
  const editable = canEdit(f);
  const full = S.notes.length >= LIMITS.notes;
  const rows = S.notes.map(noteRow);
  if (editable && !full) {
    rows.push(h("button", { class: "row action", onclick: () => noteSheet(null) },
      h("span", { class: "lead" }, icon("plus", 20)), "New note"));
  }
  const settings = [];
  if (isOwner(f)) {
    settings.push(
      h("button", { class: "row action", onclick: () => promptSheet({ title: "Rename folder", placeholder: "Folder name", value: f.name, label: "Save", onSubmit: renameFolder }) },
        h("span", { class: "lead" }, icon("pencil", 18)), "Rename folder"),
      h("button", { class: "row danger", onclick: () => confirmSheet({ title: "Delete folder", message: "This deletes the folder and all its notes for everyone it's shared with. This can't be undone.", label: "Delete folder", onConfirm: removeFolder }) },
        h("span", { class: "lead" }, icon("trash", 18)), "Delete folder")
    );
  }
  const screen = h("main", { class: "screen" },
    h("header", { class: "nav" },
      h("button", { class: "text-btn", onclick: goBack }, icon("back", 20), "Folders"),
      h("span", { class: "nav-title", text: f.name }),
      h("span", { class: "nav-r" }, h("button", { class: "icon-btn", "aria-label": "Share folder", onclick: shareSheet }, icon("share", 22)))),
    h("div", { class: "body-pad" },
      h("p", { class: "sect-f", style: null }, h("span", { class: "badge", text: roleLabel(f) })),
      group(
        "Notes",
        rows.length ? rows : [h("div", { class: "row" }, h("span", { class: "s", text: editable ? "No notes yet." : "This folder has no notes yet." }))],
        full ? `Free plan limit reached: ${LIMITS.notes} notes per folder.` : `${S.notes.length} of ${LIMITS.notes} notes`
      ),
      settings.length ? group(null, settings) : null,
      !isOwner(f) ? group(null, [h("button", { class: "row danger", onclick: () => confirmSheet({ title: "Leave folder", message: "You'll lose access until the owner adds you again.", label: "Leave folder", onConfirm: leaveFolder }) }, "Leave folder")]) : null
    )
  );
  mount(screen);
}

function render() {
  if (!S.me) return renderLogin();
  if (S.folder) return renderFolder();
  renderFolders();
}

/* ---------- actions ---------- */
async function openFolder(f) {
  S.folder = f;
  S.notes = [];
  S.anim = "push";
  render();
  await loadNotes();
  if (S.folder) render();
}
async function goBack() {
  S.folder = null;
  S.anim = "pop";
  render();
  await loadFolders();
  if (!S.folder) render();
}
function newFolder() {
  promptSheet({
    title: "New folder", placeholder: "Folder name", label: "Create",
    onSubmit: async (name) => {
      const f = await api.createFolder(name, S.me);
      S.folders.push(f);
      S.folders.sort((a, b) => a.name.localeCompare(b.name));
      render();
    },
  });
}
async function renameFolder(name) {
  await api.updateFolder(S.folder.id, { name });
  S.folder.name = name;
  render();
}
async function removeFolder() {
  await api.deleteFolder(S.folder.id);
  S.folders = S.folders.filter((f) => f.id !== S.folder.id);
  S.folder = null;
  S.anim = "pop";
  render();
  toast("Folder deleted");
}
async function leaveFolder() {
  const me = S.me.email;
  await api.updateFolder(S.folder.id, {
    memberEmails: S.folder.memberEmails.filter((e) => e !== me),
    editorEmails: S.folder.editorEmails.filter((e) => e !== me),
  });
  S.folders = S.folders.filter((f) => f.id !== S.folder.id);
  S.folder = null;
  S.anim = "pop";
  render();
}

/* ---------- note sheet ---------- */
function noteSheet(note) {
  const folder = S.folder;
  const editable = canEdit(folder);
  const isNew = !note;
  let mode = isNew ? "edit" : "view";
  openSheet((sheet, close) => {
    function drawView() {
      sheet.replaceChildren(
        sbar(textBtn("Close", close), "Note", editable ? textBtn("Edit", () => { mode = "edit"; draw(); }, true) : null),
        h("div", { class: "sheet-body" },
          h("h2", { class: "note-title", text: note.title || "Untitled" }),
          h("div", { class: "note-text" }, linkify(note.text || "")),
          note.updatedBy && h("p", { class: "meta", text: `Last edited by ${note.updatedBy}` }),
          h("div", { class: "sect" }, h("div", { class: "group" },
            h("button", { class: "row action", onclick: () => copyText(note.text || "") }, h("span", { class: "lead" }, icon("copy", 18)), "Copy text"),
            editable && h("button", { class: "row danger", onclick: () => { close(); confirmSheet({ title: "Delete note", message: "This note will be deleted for everyone with access.", label: "Delete note", onConfirm: async () => { await api.deleteNote(folder.id, note.id); await loadNotes(); render(); } }); } },
              h("span", { class: "lead" }, icon("trash", 18)), "Delete note")
          ))
        )
      );
    }
    function drawEdit() {
      const title = h("input", { class: "field", placeholder: "Title", value: note?.title || "", maxlength: "120", "aria-label": "Title" });
      const text = h("textarea", { class: "field", placeholder: "Paste a link or jot down an idea", maxlength: "5000", "aria-label": "Text" });
      text.value = note?.text || "";
      const count = h("p", { class: "sect-f" });
      const updateCount = () => {
        const n = findLinks(text.value).filter((l) => safeHref(l.raw)).length;
        count.textContent = n ? `${n} link${n > 1 ? "s" : ""} detected` : "Links you add become tappable.";
      };
      text.addEventListener("input", updateCount);
      updateCount();
      const save = async () => {
        if (!title.value.trim() && !text.value.trim()) return toast("Add a title or some text.");
        const slot = isNew ? freeSlot() : note.id;
        if (!slot) return toast(`Free plan limit reached: ${LIMITS.notes} notes per folder.`);
        close();
        await act(async () => {
          await api.saveNote(folder.id, slot, { title: title.value.trim(), text: text.value }, S.me, isNew);
          await loadNotes();
          render();
        });
      };
      const useTab = async () => {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab?.url || !safeHref(tab.url)) return toast("This page can't be saved.");
          if (!title.value.trim()) title.value = (tab.title || "").slice(0, 120);
          text.value = text.value ? text.value + "\n" + tab.url : tab.url;
          updateCount();
        } catch {
          toast("Couldn't read the current tab.");
        }
      };
      sheet.replaceChildren(
        sbar(textBtn("Cancel", () => (isNew ? close() : ((mode = "view"), draw()))), isNew ? "New note" : "Edit note", textBtn("Save", save, true)),
        h("div", { class: "sheet-body" },
          h("div", { class: "sect" }, h("div", { class: "group" }, title, text), count),
          h("div", { class: "sect" }, h("div", { class: "group" },
            h("button", { class: "row action", onclick: useTab }, h("span", { class: "lead" }, icon("tab", 18)), "Add current tab")))
        )
      );
      setTimeout(() => (isNew ? title : text).focus(), 50);
    }
    const draw = () => (mode === "edit" ? drawEdit() : drawView());
    draw();
  });
}

/* ---------- share sheet ---------- */
function shareSheet() {
  openSheet((sheet, close) => {
    let newRole = "view";
    const owner = () => isOwner(S.folder);

    async function save(fields) {
      await act(async () => {
        await api.updateFolder(S.folder.id, fields);
        Object.assign(S.folder, fields);
        draw();
      });
    }
    const setRole = (email, role) =>
      save({ editorEmails: role === "edit" ? [...new Set([...S.folder.editorEmails, email])] : S.folder.editorEmails.filter((e) => e !== email) });
    const remove = (email) =>
      save({ memberEmails: S.folder.memberEmails.filter((e) => e !== email), editorEmails: S.folder.editorEmails.filter((e) => e !== email) });

    function draw() {
      const f = S.folder;
      const emailInput = h("input", { class: "field", type: "email", placeholder: "Email of a LinkPocket user", "aria-label": "Email address", autocomplete: "off" });
      const add = async () => {
        const email = emailInput.value.trim().toLowerCase();
        if (!EMAIL_RE.test(email)) return toast("Enter a valid email address.");
        if (f.memberEmails.includes(email)) return toast("That person already has access.");
        if (f.memberEmails.length >= LIMITS.people) return toast(`Free plan limit reached: ${LIMITS.people} people per folder.`);
        await save({
          memberEmails: [...f.memberEmails, email],
          editorEmails: newRole === "edit" ? [...f.editorEmails, email] : f.editorEmails,
        });
      };
      emailInput.addEventListener("keydown", (e) => e.key === "Enter" && add());

      const people = f.memberEmails.map((email) => {
        const isOwnerRow = email === f.ownerEmail;
        const role = isOwnerRow ? "owner" : f.editorEmails.includes(email) ? "edit" : "view";
        return h("div", { class: "row" },
          h("span", { class: "row-main" },
            h("span", { class: "t", text: email }),
            email === S.me.email && h("span", { class: "s", text: "You" })),
          isOwnerRow || !owner()
            ? h("span", { class: "trail", text: role === "owner" ? "Owner" : role === "edit" ? "Can edit" : "View only" })
            : [
                seg([["view", "View"], ["edit", "Edit"]], role, (r) => setRole(email, r)),
                h("button", { class: "mini", "aria-label": `Remove ${email}`, onclick: () => remove(email) }, icon("minus", 16)),
              ]
        );
      });

      sheet.replaceChildren(
        sbar(null, "Share folder", textBtn("Done", close, true)),
        h("div", { class: "sheet-body" },
          group("People with access", people, `${f.memberEmails.length} of ${LIMITS.people} people`),
          owner() && h("section", { class: "sect" },
            h("h2", { class: "sect-h", text: "Add a person" }),
            h("div", { class: "group" },
              h("div", { class: "add-row" }, emailInput, h("button", { class: "text-btn bold", onclick: add, text: "Add" })),
              h("div", { class: "row" }, h("span", { class: "row-main" }, h("span", { class: "t", text: "Permission" })),
                seg([["view", "View only"], ["edit", "Can edit"]], newRole, (r) => { newRole = r; draw(); }))),
            h("p", { class: "sect-f", text: "They see this folder after signing in to LinkPocket with that email." })
          )
        )
      );
    }
    draw();
  });
}

/* ---------- boot ---------- */
async function boot() {
  S.me = await api.currentUser();
  if (!S.me && !(await api.wasSignedOut())) {
    try {
      S.me = await api.signIn(false); // silent re-sign-in when Google already has a session
    } catch {
      S.me = null;
    }
  }
  if (S.me) {
    render(); // show something immediately
    await loadFolders();
  }
  render();
}
boot();