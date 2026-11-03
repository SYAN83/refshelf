import { marked } from "/vendor/marked/marked.esm.js";

const $ = (sel, root = document) => root.querySelector(sel);
const state = { refs: [], activeId: null, checked: new Set(), tab: "pdf", query: "" };

// ---------- helpers ----------

async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : undefined,
    body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
  });
  if (res.status === 401) {
    location.href = "/login.html";
    throw new Error("Signed out");
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data;
}

let toastTimer;
function toast(msg, { error = false } = {}) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast" + (error ? " error" : "");
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), error ? 6000 : 3000);
}

async function busy(button, fn) {
  const label = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `<span class="spinner"></span> ${button.dataset.busy ?? "Working…"}`;
  try {
    return await fn();
  } catch (e) {
    toast(e.message, { error: true });
  } finally {
    button.disabled = false;
    button.innerHTML = label;
  }
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fullName = (a) => [a.given, a.family].filter(Boolean).join(" ");
function authorLine(authors, max = 3) {
  if (!authors.length) return "Unknown author";
  const names = authors.slice(0, max).map(fullName).join(", ");
  return authors.length > max ? `${names} et al.` : names;
}

// ---------- list ----------

async function loadRefs() {
  state.refs = await api(`/api/refs?q=${encodeURIComponent(state.query)}`);
  renderList();
}

function renderList() {
  const list = $("#ref-list");
  $("#count").textContent = state.checked.size
    ? `${state.checked.size} selected`
    : `${state.refs.length} reference${state.refs.length === 1 ? "" : "s"}`;
  $("#select-all").checked = state.refs.length > 0 && state.refs.every((r) => state.checked.has(r.id));
  if (!state.refs.length) {
    list.innerHTML = `<li class="empty-list">${state.query ? "No matches." : "Nothing here yet — import something above."}</li>`;
    return;
  }
  list.innerHTML = state.refs
    .map(
      (r) => `
    <li data-id="${r.id}" class="${r.id === state.activeId ? "active" : ""}">
      <input type="checkbox" ${state.checked.has(r.id) ? "checked" : ""} aria-label="Select" />
      <div class="meta">
        <div class="t">${esc(r.title || "Untitled")}</div>
        <div class="a">${esc(authorLine(r.authors, 2))}${r.year ? " · " + r.year : ""}</div>
        <div class="badges">
          <span class="badge ${r.has_pdf ? "on" : ""}">PDF</span>
          <span class="badge ${r.summary ? "on" : ""}">Summary</span>
          ${r.tags.split(",").map((t) => t.trim()).filter(Boolean).map((t) => `<span class="badge">${esc(t)}</span>`).join("")}
        </div>
      </div>
    </li>`,
    )
    .join("");
}

$("#ref-list").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li) return;
  const id = Number(li.dataset.id);
  if (e.target.matches("input[type=checkbox]")) {
    e.target.checked ? state.checked.add(id) : state.checked.delete(id);
    renderList();
    return;
  }
  select(id);
});

$("#select-all").addEventListener("change", (e) => {
  for (const r of state.refs) e.target.checked ? state.checked.add(r.id) : state.checked.delete(r.id);
  renderList();
});

let searchTimer;
$("#search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = e.target.value.trim();
    loadRefs();
  }, 200);
});

$("#export-btn").addEventListener("click", () => {
  const ids = [...state.checked].join(",");
  location.href = `/api/export?format=${$("#export-format").value}${ids ? `&ids=${ids}` : ""}`;
});

// ---------- import ----------

function afterImport({ ref, duplicate }) {
  toast(duplicate ? `Already in your library: ${ref.title}` : `Imported: ${ref.title}${ref.has_pdf ? "" : " (no PDF found)"}`);
  state.activeId = ref.id;
  return loadRefs().then(() => select(ref.id));
}

$("#import-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#import-input");
  if (!input.value.trim()) return;
  const btn = $("#import-btn");
  btn.dataset.busy = "Importing…";
  busy(btn, async () => {
    await afterImport(await api("/api/import", { method: "POST", body: { input: input.value } }));
    input.value = "";
  });
});

async function uploadFiles(files) {
  for (const file of files) {
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      toast(`${file.name} isn't a PDF`, { error: true });
      continue;
    }
    toast(`Importing ${file.name}…`);
    const form = new FormData();
    form.append("pdf", file);
    try {
      await afterImport(await api("/api/upload", { method: "POST", body: form }));
    } catch (e) {
      toast(`${file.name}: ${e.message}`, { error: true });
    }
  }
}

$("#upload-input").addEventListener("change", (e) => {
  uploadFiles([...e.target.files]);
  e.target.value = "";
});

let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (![...e.dataTransfer.types].includes("Files")) return;
  dragDepth++;
  $("#drop-overlay").hidden = false;
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) ($("#drop-overlay").hidden = true), (dragDepth = 0);
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("#drop-overlay").hidden = true;
  if (e.dataTransfer.files.length) uploadFiles([...e.dataTransfer.files]);
});

// ---------- detail ----------

const current = () => state.refs.find((r) => r.id === state.activeId);

async function select(id) {
  state.activeId = id;
  renderList();
  const ref = await api(`/api/refs/${id}`);
  const i = state.refs.findIndex((r) => r.id === id);
  if (i >= 0) state.refs[i] = ref;
  renderDetail(ref);
}

function replaceRef(ref) {
  const i = state.refs.findIndex((r) => r.id === ref.id);
  if (i >= 0) state.refs[i] = ref;
  renderList();
  renderDetail(ref);
}

function renderDetail(ref) {
  const root = $("#detail");
  root.replaceChildren($("#detail-tpl").content.cloneNode(true));
  $(".ref-title", root).textContent = ref.title || "Untitled";
  const venue = [ref.venue, ref.year].filter(Boolean).join(", ");
  $(".ref-byline", root).innerHTML =
    `${esc(authorLine(ref.authors, 6))}${venue ? ` — <i>${esc(venue)}</i>` : ""}` +
    (ref.doi ? ` · <a href="https://doi.org/${esc(ref.doi)}" target="_blank">doi:${esc(ref.doi)}</a>` : ref.url ? ` · <a href="${esc(ref.url)}" target="_blank">link</a>` : "");

  const open = $('[data-act="open-pdf"]', root);
  const dl = $('[data-act="download-pdf"]', root);
  open.href = `/api/refs/${ref.id}/pdf`;
  dl.href = `/api/refs/${ref.id}/pdf?download=1`;
  if (!ref.has_pdf) open.setAttribute("aria-disabled", "true"), dl.setAttribute("aria-disabled", "true");
  $('[data-act="find-pdf"]', root).hidden = ref.has_pdf;

  renderPdfTab(ref);
  renderSummaryTab(ref);
  renderCiteTab(ref);
  fillInfoForm(ref);
  showTab(state.tab);
}

function showTab(name) {
  state.tab = name;
  for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === name));
  for (const p of document.querySelectorAll(".tab")) p.classList.toggle("active", p.dataset.panel === name);
}

function renderPdfTab(ref) {
  const panel = $('[data-panel="pdf"]');
  panel.innerHTML = ref.has_pdf
    ? `<iframe class="pdf-frame" src="/api/refs/${ref.id}/pdf" title="PDF preview"></iframe>`
    : `<div class="notice">No PDF attached yet. RefShelf can look for an open-access copy, or you can attach one you downloaded yourself.
         <div class="actions"><button data-act="find-pdf" data-busy="Searching…">Find PDF</button>
         <label class="button">Attach PDF<input type="file" accept="application/pdf" data-act="attach-pdf" hidden /></label></div></div>`;
}

function renderSummaryTab(ref) {
  const panel = $('[data-panel="summary"]');
  const source = ref.has_pdf ? "the full PDF" : ref.abstract ? "the abstract only (no PDF attached)" : null;
  if (!source) {
    panel.innerHTML = `<div class="notice">Attach a PDF or add an abstract in Details to generate a summary.</div>`;
    return;
  }
  panel.innerHTML = `
    <div class="summary-actions">
      <button class="${ref.summary ? "" : "primary"}" data-act="summarize" data-busy="Reading the paper…">${ref.summary ? "Regenerate summary" : "Summarize with Claude"}</button>
      <span>Uses ${source}.</span>
    </div>
    ${ref.summary ? `<article class="summary">${marked.parse(ref.summary)}</article>` : ""}`;
}

async function renderCiteTab(ref) {
  const panel = $('[data-panel="cite"]');
  const c = await api(`/api/refs/${ref.id}/cite`);
  if (state.activeId !== ref.id) return;
  const block = (label, key, body) => `
    <div class="cite-block"><header>${label}<button data-copy="${key}">Copy</button></header>${body}</div>`;
  panel.innerHTML =
    block("BibTeX", "bibtex", `<pre>${esc(c.bibtex.text)}</pre>`) +
    block("APA 7", "apa", `<div class="formatted">${c.apa.html}</div>`) +
    block("MLA 9", "mla", `<div class="formatted">${c.mla.html}</div>`) +
    block("RIS", "ris", `<pre>${esc(c.ris.text)}</pre>`);
  panel.onclick = async (e) => {
    const key = e.target.dataset?.copy;
    if (!key) return;
    await navigator.clipboard.writeText(c[key].text);
    e.target.textContent = "Copied";
    setTimeout(() => (e.target.textContent = "Copy"), 1200);
  };
}

function fillInfoForm(ref) {
  const form = $(".info-form");
  for (const el of form.elements) {
    if (!el.name) continue;
    el.value = el.name === "authors" ? ref.authors.map((a) => (a.given ? `${a.family}, ${a.given}` : a.family)).join("\n") : ref[el.name] ?? "";
  }
}

$("#detail").addEventListener("submit", (e) => {
  if (!e.target.matches(".info-form")) return;
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  data.authors = data.authors
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      if (l.includes(",")) {
        const [family, ...given] = l.split(",");
        return { family: family.trim(), given: given.join(",").trim() };
      }
      const parts = l.split(/\s+/);
      return { given: parts.slice(0, -1).join(" "), family: parts.at(-1) };
    });
  const btn = e.submitter;
  btn.dataset.busy = "Saving…";
  busy(btn, async () => {
    replaceRef(await api(`/api/refs/${state.activeId}`, { method: "PATCH", body: data }));
    toast("Saved");
  });
});

$("#detail").addEventListener("click", (e) => {
  const tab = e.target.closest(".tabs button");
  if (tab) return showTab(tab.dataset.tab);

  const act = e.target.closest("[data-act]")?.dataset.act;
  const ref = current();
  if (!ref) return;
  const btn = e.target.closest("button");

  if (act === "find-pdf") {
    btn.dataset.busy = "Searching…";
    busy(btn, async () => {
      replaceRef(await api(`/api/refs/${ref.id}/fetch-pdf`, { method: "POST" }));
      toast("PDF found and attached");
    });
  } else if (act === "summarize") {
    busy(btn, async () => {
      replaceRef(await api(`/api/refs/${ref.id}/summarize`, { method: "POST" }));
      showTab("summary");
    });
  } else if (act === "delete") {
    if (!confirm(`Delete "${ref.title}" and its PDF?`)) return;
    api(`/api/refs/${ref.id}`, { method: "DELETE" })
      .then(() => {
        state.checked.delete(ref.id);
        state.activeId = null;
        $("#detail").innerHTML = `<div class="empty"><p>Deleted.</p></div>`;
        return loadRefs();
      })
      .catch((err) => toast(err.message, { error: true }));
  }
});

$("#detail").addEventListener("change", async (e) => {
  if (e.target.dataset.act !== "attach-pdf" || !e.target.files[0]) return;
  const form = new FormData();
  form.append("pdf", e.target.files[0]);
  try {
    replaceRef(await api(`/api/refs/${state.activeId}/pdf`, { method: "POST", body: form }));
    toast("PDF attached");
  } catch (err) {
    toast(err.message, { error: true });
  }
});

// ---------- account ----------

async function loadAccount() {
  const me = await api("/api/me");
  if (!me) return; // running with REFSHELF_NO_AUTH=1
  $("#account-name").textContent = me.name;
  $("#account").title = me.email;
  if (me.picture) Object.assign($("#account-avatar"), { src: me.picture, hidden: false });
  $("#account").hidden = false;
}

$("#logout-btn").addEventListener("click", async () => {
  await fetch("/auth/logout", { method: "POST" });
  location.href = "/login.html";
});

loadAccount().catch(() => {});
loadRefs();
