// Citation formatting: BibTeX, RIS, APA 7, MLA 9.

const STOPWORDS = new Set(["a", "an", "the", "on", "of", "in", "for", "and", "to", "with", "towards", "toward", "is", "are", "via", "from"]);

const ascii = (s) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]/g, "");

export function makeCiteKey(ref, isTaken) {
  const family = ascii(ref.authors?.[0]?.family ?? "").toLowerCase() || "anon";
  const word = (ref.title ?? "").split(/\s+/).map((w) => ascii(w).toLowerCase()).find((w) => w && !STOPWORDS.has(w)) ?? "";
  const base = `${family}${ref.year ?? ""}${word}`;
  let key = base;
  for (let i = 0; isTaken(key); i++) key = base + String.fromCharCode(97 + i); // a, b, c...
  return key;
}

// ---------- BibTeX ----------

const BIB_ESCAPES = { "&": "\\&", "%": "\\%", "$": "\\$", "#": "\\#", "_": "\\_" };
const bibEscape = (s) => String(s).replace(/[&%$#_]/g, (c) => BIB_ESCAPES[c]);

const bibName = (a) => (a.given ? `${a.family}, ${a.given}` : a.family);

export function toBibtex(ref) {
  const fields = [];
  const add = (k, v, { raw = false } = {}) => {
    if (v == null || v === "") return;
    fields.push(`  ${k.padEnd(13)} = {${raw ? v : bibEscape(v)}}`);
  };
  add("title", `{${bibEscape(ref.title)}}`, { raw: true }); // double braces preserve capitalization
  add("author", ref.authors.map(bibName).map(bibEscape).join(" and "), { raw: true });
  add("year", ref.year);
  const venueField = { article: "journal", inproceedings: "booktitle", incollection: "booktitle" }[ref.type];
  if (venueField) add(venueField, ref.venue);
  else if (ref.arxiv_id) add("howpublished", ref.venue && ref.venue !== "arXiv" ? ref.venue : `arXiv preprint arXiv:${ref.arxiv_id}`);
  else if (ref.type !== "book") add("howpublished", ref.venue);
  add("volume", ref.volume);
  add("number", ref.issue);
  add("pages", ref.pages?.replace(/\s*[-–—]\s*/g, "--"));
  add("publisher", ref.publisher);
  add("doi", ref.doi, { raw: true });
  if (ref.arxiv_id) {
    add("eprint", ref.arxiv_id, { raw: true });
    add("archivePrefix", "arXiv");
  }
  add("url", ref.url, { raw: true });
  return `@${ref.type || "misc"}{${ref.cite_key},\n${fields.join(",\n")}\n}`;
}

// ---------- RIS ----------

const RIS_TYPES = { article: "JOUR", inproceedings: "CPAPER", incollection: "CHAP", book: "BOOK", techreport: "RPRT", phdthesis: "THES" };

export function toRis(ref) {
  const lines = [`TY  - ${ref.arxiv_id && ref.type === "misc" ? "PREPRINT" : RIS_TYPES[ref.type] ?? "GEN"}`];
  const add = (tag, v) => v != null && v !== "" && lines.push(`${tag}  - ${v}`);
  add("TI", ref.title);
  for (const a of ref.authors) add("AU", bibName(a));
  add("PY", ref.year);
  add(ref.type === "article" ? "JO" : "T2", ref.venue);
  add("VL", ref.volume);
  add("IS", ref.issue);
  const [sp, ep] = (ref.pages ?? "").split(/\s*[-–—]+\s*/);
  add("SP", sp);
  add("EP", ep);
  add("PB", ref.publisher);
  add("DO", ref.doi);
  add("UR", ref.url);
  add("AB", ref.abstract);
  add("ID", ref.cite_key);
  lines.push("ER  - ");
  return lines.join("\n");
}

// ---------- APA / MLA (return HTML with <i>; strip tags for plain text) ----------

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const initials = (given) =>
  given
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p.split("-").map((h) => h[0].toUpperCase() + ".").join("-"))
    .join(" ");
const endDot = (s) => (/[.?!]$/.test(s) ? s : s + ".");
const doiUrl = (ref) => (ref.doi ? `https://doi.org/${ref.doi}` : ref.url);
const venueOf = (ref) => (ref.arxiv_id && (!ref.venue || ref.venue === "arXiv") ? null : ref.venue);

export function toApa(ref) {
  const names = ref.authors.map((a) => (a.given ? `${a.family}, ${initials(a.given)}` : a.family));
  let authors;
  if (names.length === 0) authors = "";
  else if (names.length === 1) authors = names[0];
  else if (names.length <= 20) authors = `${names.slice(0, -1).join(", ")}, & ${names.at(-1)}`;
  else authors = `${names.slice(0, 19).join(", ")}, . . . ${names.at(-1)}`;

  const year = `(${ref.year ?? "n.d."}).`;
  const venue = venueOf(ref);
  let tail = "";
  if (ref.type === "book") {
    tail = `<i>${esc(endDot(ref.title))}</i>${ref.publisher ? " " + esc(endDot(ref.publisher)) : ""}`;
  } else {
    tail = esc(endDot(ref.title));
    if (venue) {
      let v = `<i>${esc(venue)}</i>`;
      if (ref.volume) v += `, <i>${esc(ref.volume)}</i>`;
      if (ref.issue) v += `(${esc(ref.issue)})`;
      if (ref.pages) v += `, ${esc(ref.pages.replace(/--?/g, "–"))}`;
      tail += ` ${v}.`;
    } else if (ref.arxiv_id) {
      tail += " <i>arXiv</i>.";
    }
  }
  const link = doiUrl(ref);
  return [authors && esc(endDot(authors)), year, tail, link && esc(link)].filter(Boolean).join(" ");
}

export function toMla(ref) {
  const a = ref.authors;
  let authors = "";
  const inverted = (x) => (x.given ? `${x.family}, ${x.given}` : x.family);
  const straight = (x) => [x.given, x.family].filter(Boolean).join(" ");
  if (a.length === 1) authors = inverted(a[0]);
  else if (a.length === 2) authors = `${inverted(a[0])}, and ${straight(a[1])}`;
  else if (a.length > 2) authors = `${inverted(a[0])}, et al`;

  const parts = [];
  if (authors) parts.push(esc(endDot(authors)));
  const venue = venueOf(ref) ?? (ref.arxiv_id ? "arXiv" : null);
  if (ref.type === "book") {
    parts.push(`<i>${esc(endDot(ref.title))}</i>`);
    const pub = [ref.publisher, ref.year].filter(Boolean).join(", ");
    if (pub) parts.push(esc(endDot(pub)));
  } else {
    parts.push(`“${esc(endDot(ref.title))}”`);
    const container = [];
    if (venue) container.push(`<i>${esc(venue)}</i>`);
    if (ref.volume) container.push(`vol. ${esc(ref.volume)}`);
    if (ref.issue) container.push(`no. ${esc(ref.issue)}`);
    if (ref.year) container.push(String(ref.year));
    if (ref.pages) container.push(`pp. ${esc(ref.pages.replace(/--?/g, "–"))}`);
    if (container.length) parts.push(container.join(", ") + ".");
  }
  const link = ref.doi ? `https://doi.org/${ref.doi}` : ref.url;
  if (link) parts.push(esc(endDot(link)));
  return parts.join(" ");
}

export const htmlToText = (html) =>
  html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

export function format(ref, style) {
  switch (style) {
    case "bibtex": return { text: toBibtex(ref) };
    case "ris": return { text: toRis(ref) };
    case "apa": { const html = toApa(ref); return { html, text: htmlToText(html) }; }
    case "mla": { const html = toMla(ref); return { html, text: htmlToText(html) }; }
    default: throw new Error(`Unknown style: ${style}`);
  }
}
