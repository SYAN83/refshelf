# RefShelf

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
| `REFSHELF_NO_AUTH=1` | Run without sign-in (the old behaviour) |

Sessions last 30 days. Removing an email from `ALLOWED_EMAILS` and restarting revokes it immediately.

### Per-user libraries

Each signed-in user has their own library: references, PDFs, summaries, cite keys and exports are private to them, and the same paper can be in several people's libraries. Other users' references return 404. With `REFSHELF_NO_AUTH=1`, everything belongs to a single `local` library.

References created before per-user libraries existed are assigned on startup to the first email in `ALLOWED_EMAILS` (or to `local` without sign-in).

## Access from other devices

Google only allows `http://` sign-in redirects for `localhost`, so other devices need an `https://` address on a real domain. `Caddyfile` sets this up with a domain on Cloudflare; the app itself stays on `127.0.0.1` behind Caddy.

1. In Cloudflare DNS, add an **A** record `refshelf` → this machine's LAN IP (e.g. `192.168.1.242`) with the proxy **off** (grey cloud, "DNS only"). Reserve that IP for the machine in your router.
2. Create a Cloudflare API token with **Zone → DNS → Edit** for the domain.
3. Install Caddy with the Cloudflare plugin (Homebrew's `caddy` lacks it): download a build from <https://caddyserver.com/download> with `github.com/caddy-dns/cloudflare` selected, and put it on your `PATH` as `caddy`.
4. In `.env` set `BASE_URL=https://refshelf.example.com`, `REFSHELF_DOMAIN=refshelf.example.com` and `CLOUDFLARE_API_TOKEN=...`; add `https://refshelf.example.com/auth/google/callback` as an authorized redirect URI in Google Cloud Console.
5. Run `npm start` and, in a second terminal, `npm run proxy`. Open `https://refshelf.example.com` from any device on the network (including this one).

Some routers block DNS answers that point to private IPs ("DNS rebinding protection"); if the name doesn't resolve on the LAN, allow the domain in the router's settings.

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

Everything lives in `data/`: `library.db` (SQLite) and `pdfs/<id>.pdf`. Set `REFSHELF_DATA=/some/path` to keep the library somewhere else, like a synced folder.

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
