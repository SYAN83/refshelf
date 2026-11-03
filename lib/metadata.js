// Resolve DOIs, arXiv IDs and URLs into reference metadata (+ a PDF link when one is findable).
import { XMLParser } from "fast-xml-parser";

const UA = "Bibliotek/0.1 (local reference manager)";
const DOI_RE = /\b(10\.\d{4,9}\/[^\s"<>]+)/i;
const ARXIV_NEW_RE = /(?:arxiv[:\s]*)?(\d{4}\.\d{4,5})(v\d+)?/i;
const ARXIV_OLD_RE = /(?:arxiv[:\s]*)?([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/i;

export function cleanDoi(doi) {
  return doi
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .replace(/[.,;)\]}]+$/, "")
    .trim();
}

export function findDoi(text) {
  const m = text.match(DOI_RE);
  return m ? cleanDoi(m[1]) : null;
}

export function findArxivId(text) {
  const m = text.match(/arxiv\.org\/(?:abs|pdf)\/([^\s?#]+?)(?:\.pdf)?(?:[?#]|$)/i);
  if (m) return m[1].replace(/v\d+$/, "");
  const n = text.match(ARXIV_NEW_RE) ?? text.match(ARXIV_OLD_RE);
  return n ? n[1] : null;
}

/** Classify a pasted identifier. */
export function classify(input) {
  const s = input.trim();
  if (/arxiv\.org\//i.test(s) || /^arxiv:/i.test(s) || /^\d{4}\.\d{4,5}(v\d+)?$/.test(s)) {
    return { kind: "arxiv", id: findArxivId(s) };
  }
  if (/^(https?:\/\/(dx\.)?doi\.org\/|doi:\s*)?10\.\d{4,9}\//i.test(s)) return { kind: "doi", id: cleanDoi(s) };
  if (/^https?:\/\//i.test(s)) return { kind: "url", id: s };
  return { kind: "unknown", id: s };
}

async function get(url, accept) {
  const res = await fetch(url, { headers: { "User-Agent": UA, ...(accept && { Accept: accept }) }, redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching ${url}`);
  return res;
}

const stripTags = (s) => s?.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() || null;

const CROSSREF_TYPES = {
  "journal-article": "article",
  "proceedings-article": "inproceedings",
  "book-chapter": "incollection",
  book: "book",
  monograph: "book",
  "edited-book": "book",
  "posted-content": "misc",
  report: "techreport",
  dissertation: "phdthesis",
};

export async function fromDoi(doi) {
  const res = await get(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
  const w = (await res.json()).message;
  const date = (w.issued ?? w.published ?? w["published-print"] ?? w["published-online"])?.["date-parts"]?.[0];
  const pdfLink = (w.link ?? []).find((l) => l["content-type"] === "application/pdf")?.URL;
  return {
    ref: {
      type: CROSSREF_TYPES[w.type] ?? "misc",
      title: stripTags(w.title?.[0]) ?? "",
      authors: (w.author ?? []).map((a) => ({ given: a.given ?? "", family: a.family ?? a.name ?? "" })),
      year: date?.[0] ?? null,
      venue: w["container-title"]?.[0] ?? null,
      volume: w.volume ?? null,
      issue: w.issue ?? null,
      pages: w.page ?? null,
      publisher: w.publisher ?? null,
      doi: w.DOI,
      url: w.URL ?? `https://doi.org/${w.DOI}`,
      abstract: stripTags(w.abstract?.replace(/<jats:title>.*?<\/jats:title>/gi, "")),
    },
    pdfCandidates: [pdfLink, `https://doi.org/${w.DOI}`].filter(Boolean),
  };
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

export async function fromArxiv(id) {
  const res = await get(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`);
  const feed = xml.parse(await res.text()).feed;
  const e = Array.isArray(feed.entry) ? feed.entry[0] : feed.entry;
  if (!e || !e.title || String(e.id).includes("api/errors")) throw new Error(`arXiv ID not found: ${id}`);
  const authors = (Array.isArray(e.author) ? e.author : [e.author]).map((a) => splitName(a.name));
  const baseId = String(e.id).split("/abs/")[1].replace(/v\d+$/, "");
  return {
    ref: {
      type: "misc",
      title: String(e.title).replace(/\s+/g, " ").trim(),
      authors,
      year: Number(String(e.published).slice(0, 4)),
      venue: e["arxiv:journal_ref"] ? String(e["arxiv:journal_ref"]) : "arXiv",
      doi: e["arxiv:doi"] ? String(e["arxiv:doi"]) : null,
      arxiv_id: baseId,
      url: `https://arxiv.org/abs/${baseId}`,
      abstract: String(e.summary).replace(/\s+/g, " ").trim(),
    },
    pdfCandidates: [`https://arxiv.org/pdf/${baseId}`],
  };
}

export function splitName(name) {
  name = String(name).trim();
  if (name.includes(",")) {
    const [family, given] = name.split(",", 2).map((s) => s.trim());
    return { given, family };
  }
  const parts = name.split(/\s+/);
  return { given: parts.slice(0, -1).join(" "), family: parts.at(-1) ?? "" };
}

/** Read Highwire/Dublin Core <meta> tags that most publishers and repositories expose. */
function metaTags(html) {
  const tags = {};
  for (const m of html.matchAll(/<meta\s+[^>]*>/gi)) {
    const tag = m[0];
    const name = tag.match(/(?:name|property)\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    const content = tag.match(/content\s*=\s*["']([^"']*)["']/i)?.[1];
    if (name && content != null) (tags[name] ??= []).push(decodeEntities(content));
  }
  return tags;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

// bioRxiv/medRxiv-style URLs append a version ("…002386v4") that isn't part of the DOI.
const doiInUrl = (url) => findDoi(decodeURIComponent(url))?.replace(/v\d+$/, "") ?? null;

/**
 * Resolve a web page. Returns { ref, pdfCandidates } or { pdfBuffer } when the URL is itself a PDF.
 */
export async function fromUrl(url) {
  const arxiv = findArxivId(url);
  if (/arxiv\.org\//i.test(url) && arxiv) return fromArxiv(arxiv);

  let res;
  try {
    res = await get(url, "text/html,application/pdf;q=0.9,*/*;q=0.5");
  } catch (err) {
    // Many publishers block scripted page fetches; a DOI in the URL itself is still enough.
    const doi = doiInUrl(url);
    if (!doi) throw err;
    const r = await fromDoi(doi);
    return { ref: { ...r.ref, url }, pdfCandidates: r.pdfCandidates };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (isPdf(buf)) return { pdfBuffer: buf, sourceUrl: res.url };

  const html = buf.toString("utf8");
  const t = metaTags(html);
  const first = (...keys) => keys.map((k) => t[k]?.[0]).find(Boolean) ?? null;
  const pdfUrl = first("citation_pdf_url");
  const doi = first("citation_doi", "dc.identifier", "prism.doi", "bepress_citation_doi") ?? doiInUrl(url);
  const pdfCandidates = pdfUrl ? [new URL(pdfUrl, res.url).href] : [];

  if (doi && findDoi(doi)) {
    try {
      const r = await fromDoi(findDoi(doi));
      return { ref: { ...r.ref, url }, pdfCandidates: [...pdfCandidates, ...r.pdfCandidates] };
    } catch { /* fall through to page metadata */ }
  }

  const title = first("citation_title", "dc.title", "og:title") ?? stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]) ?? url;
  const date = first("citation_publication_date", "citation_date", "dc.date", "article:published_time");
  return {
    ref: {
      type: t.citation_journal_title ? "article" : t.citation_conference_title ? "inproceedings" : "misc",
      title,
      authors: (t.citation_author ?? t["dc.creator"] ?? []).map(splitName),
      year: date ? Number(date.match(/\d{4}/)?.[0]) || null : null,
      venue: first("citation_journal_title", "citation_conference_title", "og:site_name"),
      volume: first("citation_volume"),
      issue: first("citation_issue"),
      pages: [first("citation_firstpage"), first("citation_lastpage")].filter(Boolean).join("-") || null,
      publisher: first("citation_publisher", "dc.publisher"),
      doi: doi ? findDoi(doi) : null,
      url,
      abstract: first("citation_abstract", "dc.description", "description", "og:description"),
    },
    pdfCandidates,
  };
}

export function isPdf(buf) {
  return buf.length > 4 && buf.subarray(0, 5).toString("latin1") === "%PDF-";
}

/** Try each candidate URL; return the first response that is actually a PDF. */
export async function downloadPdf(candidates) {
  for (const url of candidates) {
    try {
      const res = await get(url, "application/pdf,text/html;q=0.5");
      const buf = Buffer.from(await res.arrayBuffer());
      if (isPdf(buf)) return buf;
      // Landing page: look for a citation_pdf_url and try that once.
      const pdfUrl = metaTags(buf.toString("utf8")).citation_pdf_url?.[0];
      if (pdfUrl) {
        const r2 = await get(new URL(pdfUrl, res.url).href, "application/pdf");
        const b2 = Buffer.from(await r2.arrayBuffer());
        if (isPdf(b2)) return b2;
      }
    } catch { /* try next */ }
  }
  return null;
}

/** Open-access lookup via Unpaywall (needs a contact email). */
export async function unpaywallPdf(doi) {
  const email = process.env.UNPAYWALL_EMAIL;
  if (!email || !doi) return [];
  try {
    const res = await get(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`);
    const j = await res.json();
    return [j.best_oa_location?.url_for_pdf, ...(j.oa_locations ?? []).map((l) => l.url_for_pdf)].filter(Boolean);
  } catch {
    return [];
  }
}
