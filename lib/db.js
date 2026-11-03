import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export const DATA_DIR = path.resolve(process.env.REFSHELF_DATA ?? "data");
export const PDF_DIR = path.join(DATA_DIR, "pdfs");
fs.mkdirSync(PDF_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "library.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS refs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner      TEXT NOT NULL DEFAULT '',     -- signed-in user's email ('local' without sign-in)
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
`);

// Migrate libraries created before per-user ownership: add the column and make
// the duplicate checks per owner instead of global.
if (!db.prepare("PRAGMA table_info(refs)").all().some((c) => c.name === "owner")) {
  db.exec("ALTER TABLE refs ADD COLUMN owner TEXT NOT NULL DEFAULT ''");
}
db.exec(`
  DROP INDEX IF EXISTS refs_doi;
  DROP INDEX IF EXISTS refs_arxiv;
  CREATE UNIQUE INDEX IF NOT EXISTS refs_owner_doi ON refs(owner, lower(doi)) WHERE doi IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS refs_owner_arxiv ON refs(owner, arxiv_id) WHERE arxiv_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS refs_owner ON refs(owner, created_at);
`);

/** Give references that have no owner yet (from before per-user libraries) to `owner`. Returns how many. */
export function claimUnowned(owner) {
  return Number(db.prepare("UPDATE refs SET owner = ? WHERE owner = ''").run(owner).changes);
}

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

export function listRefs(owner, q = "") {
  const rows = q
    ? db.prepare(
        `SELECT * FROM refs WHERE owner = :owner AND (title LIKE :q OR authors LIKE :q OR venue LIKE :q
         OR tags LIKE :q OR doi LIKE :q OR cite_key LIKE :q) ORDER BY created_at DESC, id DESC`,
      ).all({ owner, q: `%${q}%` })
    : db.prepare("SELECT * FROM refs WHERE owner = ? ORDER BY created_at DESC, id DESC").all(owner);
  return rows.map(hydrate);
}

/** A reference, or null if it doesn't exist or belongs to someone else. */
export function getRef(owner, id) {
  return hydrate(db.prepare("SELECT * FROM refs WHERE id = ? AND owner = ?").get(id, owner));
}

export function findExisting(owner, { doi, arxiv_id }) {
  if (doi) {
    const row = db.prepare("SELECT * FROM refs WHERE owner = ? AND lower(doi) = lower(?)").get(owner, doi);
    if (row) return hydrate(row);
  }
  if (arxiv_id) {
    const row = db.prepare("SELECT * FROM refs WHERE owner = ? AND arxiv_id = ?").get(owner, arxiv_id);
    if (row) return hydrate(row);
  }
  return null;
}

export function insertRef(owner, ref) {
  const data = { ...dehydrate(ref), owner };
  const cols = Object.keys(data);
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO refs (${cols.join(", ")}) VALUES (${cols.map((c) => ":" + c).join(", ")})`)
    .run(data);
  return getRef(owner, Number(lastInsertRowid));
}

export function updateRef(owner, id, patch) {
  const data = dehydrate(patch);
  const cols = Object.keys(data);
  if (cols.length) {
    db.prepare(`UPDATE refs SET ${cols.map((c) => `${c} = :${c}`).join(", ")} WHERE id = :id AND owner = :owner`)
      .run({ ...data, id, owner });
  }
  return getRef(owner, id);
}

export function deleteRef(owner, id) {
  const ref = getRef(owner, id);
  if (!ref) return false;
  if (ref.pdf_file) fs.rmSync(path.join(PDF_DIR, ref.pdf_file), { force: true });
  db.prepare("DELETE FROM refs WHERE id = ? AND owner = ?").run(id, owner);
  return true;
}

/** Cite keys only need to be unique within one user's library. */
export function citeKeyTaken(owner, key, exceptId = null) {
  return Boolean(db.prepare("SELECT 1 FROM refs WHERE owner = ? AND cite_key = ? AND id IS NOT ?").get(owner, key, exceptId));
}
