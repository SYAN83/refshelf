// Google sign-in gate: only emails in ALLOWED_EMAILS can use the app.
// Sessions are stateless HMAC-signed cookies, so no session store is needed.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { OAuth2Client } from "google-auth-library";
import { DATA_DIR } from "./db.js";

const SESSION_COOKIE = "refshelf_session";
const STATE_COOKIE = "refshelf_oauth_state";
const SESSION_DAYS = 30;

// Pages and assets that must load before sign-in.
const PUBLIC_PATHS = new Set(["/login.html", "/style.css", "/favicon.ico"]);

/** SESSION_SECRET from env, else a random one persisted in the data dir (so restarts keep you signed in). */
function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, ".session-secret");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    const secret = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
}

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setupAuth(app, { baseUrl }) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const allowed = (process.env.ALLOWED_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!clientId || !clientSecret || !allowed.length) {
    throw new Error(
      "Google sign-in is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and ALLOWED_EMAILS (see README), " +
        "or set REFSHELF_NO_AUTH=1 to run without sign-in.",
    );
  }

  const secret = loadSecret();
  const secure = baseUrl.startsWith("https://");
  const redirectUri = `${baseUrl}/auth/google/callback`;
  const google = new OAuth2Client(clientId, clientSecret, redirectUri);

  const sign = (payload) => crypto.createHmac("sha256", secret).update(payload).digest("base64url");

  function cookie(res, name, value, maxAgeSec) {
    const attrs = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSec}`];
    if (secure) attrs.push("Secure");
    res.append("Set-Cookie", attrs.join("; "));
  }

  function readSession(req) {
    const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!raw) return null;
    const [payload, sig] = raw.split(".");
    if (!payload || !sig) return null;
    const expected = Buffer.from(sign(payload));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    try {
      const user = JSON.parse(Buffer.from(payload, "base64url").toString());
      // Re-check the allowlist so removing an email revokes access immediately.
      if (user.exp < Date.now() || !allowed.includes(user.email)) return null;
      return user;
    } catch {
      return null;
    }
  }

  const fail = (res, msg) => res.redirect(`/login.html?error=${encodeURIComponent(msg)}`);

  app.get("/auth/google", (req, res) => {
    const state = crypto.randomBytes(16).toString("hex");
    cookie(res, STATE_COOKIE, state, 600);
    res.redirect(google.generateAuthUrl({ scope: ["openid", "email", "profile"], state, prompt: "select_account" }));
  });

  app.get("/auth/google/callback", async (req, res) => {
    const expectedState = parseCookies(req.headers.cookie)[STATE_COOKIE];
    cookie(res, STATE_COOKIE, "", 0);
    if (req.query.error) return fail(res, `Google sign-in was cancelled (${req.query.error})`);
    if (!expectedState || req.query.state !== expectedState) return fail(res, "Sign-in expired, please try again");
    try {
      const { tokens } = await google.getToken(String(req.query.code ?? ""));
      const ticket = await google.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
      const { email = "", email_verified, name, picture } = ticket.getPayload();
      const normalized = email.toLowerCase();
      if (!email_verified || !allowed.includes(normalized)) return fail(res, `${email || "This account"} isn't allowed to use this library`);
      const user = { email: normalized, name: name ?? email, picture: picture ?? null, exp: Date.now() + SESSION_DAYS * 864e5 };
      const payload = Buffer.from(JSON.stringify(user)).toString("base64url");
      cookie(res, SESSION_COOKIE, `${payload}.${sign(payload)}`, SESSION_DAYS * 86400);
      res.redirect("/");
    } catch (err) {
      console.error("Google sign-in failed:", err.message);
      fail(res, "Google sign-in failed, please try again");
    }
  });

  app.post("/auth/logout", (req, res) => {
    cookie(res, SESSION_COOKIE, "", 0);
    res.status(204).end();
  });

  // Gate everything else: APIs get 401, pages redirect to the login screen.
  app.use((req, res, next) => {
    if (PUBLIC_PATHS.has(req.path)) return next();
    const user = readSession(req);
    if (user) {
      req.user = user;
      return next();
    }
    if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Sign in required" });
    res.redirect("/login.html");
  });

  app.get("/api/me", (req, res) => res.json({ email: req.user.email, name: req.user.name, picture: req.user.picture }));

  console.log(`Google sign-in enabled for: ${allowed.join(", ")} (redirect URI: ${redirectUri})`);
  return { allowed };
}
