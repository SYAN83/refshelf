import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export const DATA_DIR = path.resolve(process.env.BIBLIOTEK_DATA ?? "data");
export const PDF_DIR = path.join(DATA_DIR, "pdfs");
fs.mkdirSync(PDF_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "library.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS refs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL DEFAULT 'article',
    title      TEXT NOT NULL DEFAULT '',
    authors    TEXT NOT NULL DEFAULT '[]',  -- JSON [{given, family}]
    year       INTEGER,
    venue      TEXT,
    volume     TEXT,
    issue      TEXT,
    pages      TEXT,
    publisher  TEXT,
    doi        TEXT,
    arxiv_id   TEXT,
    url        TEXT,
    abstract   TEXT,
    cite_key   TEXT,
    tags       TEXT NOT NULL DEFAULT '',
    notes      TEXT NOT NULL DEFAULT '',
    pdf_file   TEXT,
    summary    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS refs_doi ON refs(lower(doi)) WHERE doi IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS refs_arxiv ON refs(arxiv_id) WHERE arxiv_id IS NOT NULL;
`);

const FIELDS = [
  "type", "title", "authors", "year", "venue", "volume", "issue", "pages", "publisher",
  "doi", "arxiv_id", "url", "abstract", "cite_key", "tags", "notes", "pdf_file", "summary",
];

function hydrate(row) {
  if (!row) return null;
  return { ...row, authors: JSON.parse(row.authors), has_pdf: Boolean(row.pdf_file) };
}

function dehydrate(ref) {
  const out = {};
  for (const f of FIELDS) {
    if (!(f in ref)) continue;
    const v = ref[f];
    out[f] = f === "authors" ? JSON.stringify(v ?? []) : v === "" && f !== "tags" && f !== "notes" ? null : v ?? null;
  }
  return out;
}

export function listRefs(q = "") {
  const rows = q
    ? db.prepare(
        `SELECT * FROM refs WHERE title LIKE :q OR authors LIKE :q OR venue LIKE :q OR tags LIKE :q
         OR doi LIKE :q OR cite_key LIKE :q ORDER BY created_at DESC, id DESC`,
      ).all({ q: `%${q}%` })
    : db.prepare("SELECT * FROM refs ORDER BY created_at DESC, id DESC").all();
  return rows.map(hydrate);
}

export function getRef(id) {
  return hydrate(db.prepare("SELECT * FROM refs WHERE id = ?").get(id));
}

export function findExisting({ doi, arxiv_id }) {
  if (doi) {
    const row = db.prepare("SELECT * FROM refs WHERE lower(doi) = lower(?)").get(doi);
    if (row) return hydrate(row);
  }
  if (arxiv_id) {
    const row = db.prepare("SELECT * FROM refs WHERE arxiv_id = ?").get(arxiv_id);
    if (row) return hydrate(row);
  }
  return null;
}

export function insertRef(ref) {
  const data = dehydrate(ref);
  const cols = Object.keys(data);
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO refs (${cols.join(", ")}) VALUES (${cols.map((c) => ":" + c).join(", ")})`)
    .run(data);
  return getRef(Number(lastInsertRowid));
}

export function updateRef(id, patch) {
  const data = dehydrate(patch);
  const cols = Object.keys(data);
  if (cols.length) {
    db.prepare(`UPDATE refs SET ${cols.map((c) => `${c} = :${c}`).join(", ")} WHERE id = :id`).run({ ...data, id });
  }
  return getRef(id);
}

export function deleteRef(id) {
  const ref = getRef(id);
  if (!ref) return false;
  if (ref.pdf_file) fs.rmSync(path.join(PDF_DIR, ref.pdf_file), { force: true });
  db.prepare("DELETE FROM refs WHERE id = ?").run(id);
  return true;
}

export function citeKeyTaken(key, exceptId = null) {
  return Boolean(db.prepare("SELECT 1 FROM refs WHERE cite_key = ? AND id IS NOT ?").get(key, exceptId));
}
