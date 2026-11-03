# Bibliotek

A local reference manager. Import papers by DOI, arXiv ID, URL, or PDF upload, then preview and download PDFs, get Claude summaries, and export BibTeX, RIS, APA or MLA citations.

## Run

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...      # needed for summaries only
export UNPAYWALL_EMAIL=you@example.com   # optional: lets "Find PDF" search open-access copies via Unpaywall
npm start                                # → http://localhost:4747
```

Requires Node 22.13+ (it uses the built-in `node:sqlite`).

## Google sign-in

The app is gated behind Google sign-in: only the accounts in `ALLOWED_EMAILS` can open the library.

1. In [Google Cloud Console](https://console.cloud.google.com/), set up the **OAuth consent screen** (External; add yourself as a test user).
2. Under **Credentials → Create credentials → OAuth client ID**, choose **Web application** and add the authorized redirect URI `http://localhost:4747/auth/google/callback`.
3. Export the credentials before `npm start`:

```bash
export GOOGLE_CLIENT_ID=....apps.googleusercontent.com
export GOOGLE_CLIENT_SECRET=...
export ALLOWED_EMAILS=you@gmail.com,colleague@gmail.com
```

| Variable | Purpose |
|---|---|
| `BASE_URL` | Public URL of the app if it isn't `http://localhost:4747` (the redirect URI is `$BASE_URL/auth/google/callback`; `https://` URLs also get `Secure` cookies) |
| `SESSION_SECRET` | Key used to sign session cookies. If unset, a random one is generated and kept in `data/.session-secret`. Changing it signs everyone out |
| `BIBLIOTEK_NO_AUTH=1` | Run without sign-in (the old behaviour) |

Sessions last 30 days. Removing an email from `ALLOWED_EMAILS` and restarting revokes it immediately.

## What it does

| Feature | How |
|---|---|
| Import by DOI | Crossref metadata (`10.1038/nature14539`, `https://doi.org/…`) |
| Import by arXiv | arXiv API, and the PDF is downloaded automatically (`1706.03762`, `arxiv.org/abs/…`) |
| Import by URL | Reads the page's `citation_*` meta tags; falls back to a DOI in the URL; a direct `.pdf` link is handled like an upload |
| Upload PDF | Button or drag and drop anywhere. Finds the DOI or arXiv ID on the first pages and looks up metadata; otherwise uses the PDF's own info |
| Find PDF | arXiv, Unpaywall (if `UNPAYWALL_EMAIL` is set), Crossref links, and the publisher page's `citation_pdf_url` |
| Summaries | Sends the full PDF to Claude Opus 5.5 (or the abstract if there's no PDF), which returns a structured Markdown summary |
| Citations | BibTeX, APA 7, MLA 9, RIS per reference; export the checked references (or all of them) as `.bib` / `.ris` / `.txt` |
| Editing | Every field is editable in the Details tab, plus tags and notes |

## Data

Everything lives in `data/`: `library.db` (SQLite) and `pdfs/<id>.pdf`. Set `BIBLIOTEK_DATA=/some/path` to keep the library somewhere else, like a synced folder.

## Layout

```
server.js          Express routes
lib/db.js          SQLite storage
lib/metadata.js    DOI / arXiv / URL resolution, PDF discovery
lib/pdf.js         PDF text extraction (pdf.js)
lib/cite.js        BibTeX, RIS, APA, MLA formatting + cite keys
lib/summarize.js   Claude summaries
lib/auth.js        Google sign-in and session gate
public/            Frontend (vanilla JS, no build step)
```
