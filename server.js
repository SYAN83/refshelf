import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import * as db from "./lib/db.js";
import * as meta from "./lib/metadata.js";
import { pdfText } from "./lib/pdf.js";
import { format, makeCiteKey } from "./lib/cite.js";
import { summarize } from "./lib/summarize.js";
import { setupAuth } from "./lib/auth.js";

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

const port = Number(process.env.PORT ?? 4747);
const host = process.env.HOST ?? "127.0.0.1";
const baseUrl = (process.env.BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, "");

app.use(express.json({ limit: "2mb" }));
// Each reference belongs to one user (their sign-in email). Without sign-in, everything belongs to "local".
const LOCAL_OWNER = "local";
let legacyOwner;
if (process.env.REFSHELF_NO_AUTH === "1") {
  console.warn("REFSHELF_NO_AUTH=1: running without sign-in");
  app.use((req, res, next) => {
    req.user = { email: LOCAL_OWNER };
    next();
  });
  app.get("/api/me", (req, res) => res.json(null));
  legacyOwner = LOCAL_OWNER;
} else {
  try {
    legacyOwner = setupAuth(app, { baseUrl }).allowed[0];
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
// References from before per-user libraries go to the first allowed user (or "local").
const claimed = db.claimUnowned(legacyOwner);
if (claimed) console.log(`Assigned ${claimed} existing reference(s) to ${legacyOwner}`);
app.use(express.static("public"));
app.use("/vendor/marked", express.static("node_modules/marked/lib"));

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** The signed-in user's reference, or 404 (also for other users' references, so IDs can't be probed). */
function mustGet(req, id) {
  const ref = db.getRef(req.user.email, Number(id));
  if (!ref) throw new HttpError(404, "Reference not found");
  return ref;
}

function savePdf(owner, id, buf) {
  const file = `${id}.pdf`;
  fs.writeFileSync(path.join(db.PDF_DIR, file), buf);
  return db.updateRef(owner, id, { pdf_file: file });
}

async function tryFetchPdf(owner, ref, candidates = []) {
  const urls = [...(await meta.unpaywallPdf(ref.doi)), ...candidates];
  if (ref.arxiv_id) urls.unshift(`https://arxiv.org/pdf/${ref.arxiv_id}`);
  const buf = await meta.downloadPdf([...new Set(urls)]);
  return buf ? savePdf(owner, ref.id, buf) : ref;
}

/** Insert a resolved reference (or return the existing one), then attach / fetch its PDF. */
async function addRef(owner, { ref, pdfCandidates = [], pdfBuffer = null }) {
  const existing = db.findExisting(owner, ref);
  if (existing) {
    if (pdfBuffer && !existing.has_pdf) return { ref: savePdf(owner, existing.id, pdfBuffer), duplicate: true };
    return { ref: existing, duplicate: true };
  }
  const created = db.insertRef(owner, { ...ref, cite_key: makeCiteKey(ref, (k) => db.citeKeyTaken(owner, k)) });
  const withPdf = pdfBuffer ? savePdf(owner, created.id, pdfBuffer) : await tryFetchPdf(owner, created, pdfCandidates);
  return { ref: withPdf, duplicate: false };
}

/** Work out metadata for a bare PDF: DOI or arXiv ID on the first pages, else the PDF's own info. */
async function resolvePdf(buf, sourceUrl = null) {
  const { text, info } = await pdfText(buf, 2);
  const arxiv = text.match(/arXiv:\s*(\d{4}\.\d{4,5})(v\d+)?/i)?.[1];
  const doi = meta.findDoi(text.split("\n").slice(0, 80).join("\n"));
  for (const attempt of [doi && (() => meta.fromDoi(doi)), arxiv && (() => meta.fromArxiv(arxiv))]) {
    if (!attempt) continue;
    try {
      return { ...(await attempt()), pdfBuffer: buf };
    } catch { /* try next */ }
  }
  const firstLine = text.split("\n").map((l) => l.trim()).find((l) => l.length > 10) ?? "Untitled PDF";
  return {
    ref: {
      type: "misc",
      title: info.Title?.trim() || firstLine.slice(0, 300),
      authors: info.Author ? info.Author.split(/;|,| and /).map((s) => s.trim()).filter(Boolean).map(meta.splitName) : [],
      year: Number(info.CreationDate?.match(/D:(\d{4})/)?.[1]) || null,
      url: sourceUrl,
    },
    pdfBuffer: buf,
  };
}

// ---------- routes ----------

app.get("/api/refs", (req, res) => res.json(db.listRefs(req.user.email, String(req.query.q ?? "").trim())));

app.get("/api/refs/:id", (req, res) => res.json(mustGet(req, req.params.id)));

app.post("/api/import", wrap(async (req, res) => {
  const input = String(req.body.input ?? "").trim();
  if (!input) throw new HttpError(400, "Paste a DOI, arXiv ID, or URL");
  const { kind, id } = meta.classify(input);
  let resolved;
  if (kind === "doi") resolved = await meta.fromDoi(id);
  else if (kind === "arxiv") resolved = await meta.fromArxiv(id);
  else if (kind === "url") {
    resolved = await meta.fromUrl(id);
    if (resolved.pdfBuffer) resolved = await resolvePdf(resolved.pdfBuffer, resolved.sourceUrl);
  } else {
    throw new HttpError(400, `Couldn't recognise "${input}" as a DOI, arXiv ID, or URL`);
  }
  res.json(await addRef(req.user.email, resolved));
}));

app.post("/api/upload", upload.single("pdf"), wrap(async (req, res) => {
  if (!req.file) throw new HttpError(400, "No file uploaded");
  if (!meta.isPdf(req.file.buffer)) throw new HttpError(400, "That file isn't a PDF");
  res.json(await addRef(req.user.email, await resolvePdf(req.file.buffer)));
}));

app.post("/api/refs/:id/pdf", upload.single("pdf"), wrap(async (req, res) => {
  const ref = mustGet(req, req.params.id);
  if (!req.file || !meta.isPdf(req.file.buffer)) throw new HttpError(400, "Upload a PDF file");
  res.json(savePdf(req.user.email, ref.id, req.file.buffer));
}));

app.post("/api/refs/:id/fetch-pdf", wrap(async (req, res) => {
  const ref = mustGet(req, req.params.id);
  const candidates = [ref.doi && `https://doi.org/${ref.doi}`, ref.url].filter(Boolean);
  if (ref.doi) {
    try {
      candidates.unshift(...(await meta.fromDoi(ref.doi)).pdfCandidates);
    } catch { /* ignore */ }
  }
  const updated = await tryFetchPdf(req.user.email, ref, candidates);
  if (!updated.has_pdf) throw new HttpError(404, "No freely accessible PDF found. Download it yourself and attach it.");
  res.json(updated);
}));

app.get("/api/refs/:id/pdf", (req, res) => {
  const ref = mustGet(req, req.params.id);
  if (!ref.pdf_file) throw new HttpError(404, "No PDF attached");
  const name = `${ref.cite_key || "reference"}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename="${name}"`);
  res.sendFile(path.join(db.PDF_DIR, ref.pdf_file));
});

app.patch("/api/refs/:id", (req, res) => {
  const ref = mustGet(req, req.params.id);
  const allowed = ["type", "title", "authors", "year", "venue", "volume", "issue", "pages", "publisher", "doi", "url", "abstract", "cite_key", "tags", "notes", "summary"];
  const patch = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  if (patch.cite_key && db.citeKeyTaken(req.user.email, patch.cite_key, ref.id)) throw new HttpError(409, `Cite key "${patch.cite_key}" is already used`);
  if ("year" in patch) patch.year = Number(patch.year) || null;
  res.json(db.updateRef(req.user.email, ref.id, patch));
});

app.delete("/api/refs/:id", (req, res) => {
  mustGet(req, req.params.id);
  db.deleteRef(req.user.email, Number(req.params.id));
  res.status(204).end();
});

app.post("/api/refs/:id/summarize", wrap(async (req, res) => {
  const ref = mustGet(req, req.params.id);
  const pdf = ref.pdf_file ? fs.readFileSync(path.join(db.PDF_DIR, ref.pdf_file)) : null;
  res.json(db.updateRef(req.user.email, ref.id, { summary: await summarize(ref, pdf) }));
}));

app.get("/api/refs/:id/cite", (req, res) => {
  const ref = mustGet(req, req.params.id);
  res.json(Object.fromEntries(["bibtex", "apa", "mla", "ris"].map((s) => [s, format(ref, s)])));
});

const EXPORTS = {
  bibtex: { ext: "bib", sep: "\n\n", type: "application/x-bibtex" },
  ris: { ext: "ris", sep: "\n\n", type: "application/x-research-info-systems" },
  apa: { ext: "txt", sep: "\n\n", type: "text/plain" },
  mla: { ext: "txt", sep: "\n\n", type: "text/plain" },
};

app.get("/api/export", (req, res) => {
  const fmt = String(req.query.format ?? "bibtex");
  const spec = EXPORTS[fmt];
  if (!spec) throw new HttpError(400, `Unknown format: ${fmt}`);
  const ids = String(req.query.ids ?? "").split(",").filter(Boolean).map(Number);
  const owner = req.user.email;
  let refs = ids.length ? ids.map((id) => db.getRef(owner, id)).filter(Boolean) : db.listRefs(owner);
  if (fmt === "apa" || fmt === "mla") refs = refs.sort((a, b) => (a.authors[0]?.family ?? a.title).localeCompare(b.authors[0]?.family ?? b.title));
  res.setHeader("Content-Type", `${spec.type}; charset=utf-8`);
  res.setHeader("Content-Disposition", `attachment; filename="refshelf.${spec.ext}"`);
  res.send(refs.map((r) => format(r, fmt).text).join(spec.sep) + "\n");
});

app.use((err, req, res, _next) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message });
});

app.listen(port, host, () => console.log(`RefShelf running at http://${host === "127.0.0.1" ? "localhost" : host}:${port}`));
