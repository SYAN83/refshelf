const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    location.href = "/login.html";
    throw new Error("Signed out");
  }
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

// SQLite datetime('now') is UTC without a zone marker.
const when = (s) => (s ? new Date(s.replace(" ", "T") + "Z").toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");

const SECTIONS = [
  { status: "pending", title: "Waiting for approval", empty: "No requests waiting." },
  { status: "approved", title: "Approved", empty: "No approved users yet." },
  { status: "denied", title: "Declined", empty: null },
];

function actions(u) {
  if (u.isAdmin) return `<span class="badge on">Admin</span>`;
  if (u.status === "pending")
    return `<button class="primary" data-email="${esc(u.email)}" data-status="approved">Approve</button>
            <button class="danger" data-email="${esc(u.email)}" data-status="denied">Decline</button>`;
  if (u.status === "approved") return `<button class="danger" data-email="${esc(u.email)}" data-status="denied">Revoke access</button>`;
  return `<button data-email="${esc(u.email)}" data-status="approved">Approve</button>`;
}

function row(u) {
  const avatar = u.picture
    ? `<img src="${esc(u.picture)}" alt="" referrerpolicy="no-referrer" />`
    : `<span class="avatar-fallback">${esc((u.name || u.email)[0].toUpperCase())}</span>`;
  const detail =
    u.status === "pending"
      ? `Requested ${when(u.requested_at)}`
      : `${u.refs} reference${u.refs === 1 ? "" : "s"}${u.decided_at && !u.isAdmin ? ` · ${u.status === "approved" ? "approved" : "declined"} ${when(u.decided_at)}` : ""}`;
  return `<li class="user-row">
    ${avatar}
    <div class="user-meta"><div class="t">${esc(u.name || u.email)}</div><div class="a">${esc(u.email)} · ${detail}</div></div>
    <div class="user-actions">${actions(u)}</div>
  </li>`;
}

async function load() {
  const users = await api("/api/admin/users");
  $("#user-sections").innerHTML = SECTIONS.map(({ status, title, empty }) => {
    const list = users.filter((u) => u.status === status);
    if (!list.length && !empty) return "";
    return `<section class="user-section">
      <h2>${title} <span class="count">${list.length}</span></h2>
      ${list.length ? `<ul class="user-list">${list.map(row).join("")}</ul>` : `<p class="admin-intro">${empty}</p>`}
    </section>`;
  }).join("");
}

$("#user-sections").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-email]");
  if (!btn) return;
  const { email, status } = btn.dataset;
  if (status === "denied" && btn.textContent.includes("Revoke") && !confirm(`Revoke access for ${email}? They'll be signed out right away.`)) return;
  btn.disabled = true;
  try {
    await api(`/api/admin/users/${encodeURIComponent(email)}`, { method: "POST", body: { status } });
    toast(status === "approved" ? `Approved ${email}` : `Declined ${email}`);
    await load();
  } catch (err) {
    toast(err.message, { error: true });
    btn.disabled = false;
  }
});

load().catch((err) => toast(err.message, { error: true }));
setInterval(() => load().catch(() => {}), 30000);
