// Google sign-in with sign-up requests: any verified Google account can ask for access,
// and an admin (ADMIN_EMAILS) approves or declines it on /admin.html.
// Sessions are stateless HMAC-signed cookies; the user's approval status is checked
// in the database on every request, so approving or revoking takes effect immediately.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { OAuth2Client } from "google-auth-library";
import * as db from "./db.js";

const SESSION_COOKIE = "refshelf_session";
const STATE_COOKIE = "refshelf_oauth_state";
const SESSION_DAYS = 30;

// Pages and assets that load before sign-in or while a request is pending.
const PUBLIC_PATHS = new Set(["/login.html", "/pending.html", "/style.css", "/favicon.ico"]);
// What a signed-in user whose request is still pending may use.
const PENDING_PATHS = new Set(["/api/me"]);

/** SESSION_SECRET from env, else a random one persisted in the data dir (so restarts keep you signed in). */
function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(db.DATA_DIR, ".session-secret");
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

const parseEmails = (v) => (v ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);

export function setupAuth(app, { baseUrl }) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  // ALLOWED_EMAILS is the older name for the admin list.
  const admins = parseEmails(process.env.ADMIN_EMAILS ?? process.env.ALLOWED_EMAILS);
  if (!clientId || !clientSecret || !admins.length) {
    throw new Error(
      "Google sign-in is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and ADMIN_EMAILS (see README), " +
        "or set REFSHELF_NO_AUTH=1 to run without sign-in.",
    );
  }
  const isAdmin = (email) => admins.includes(email);

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

  /** The signed session's user, or null if missing, tampered with or expired. */
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
      return user.exp > Date.now() && user.email ? user : null;
    } catch {
      return null;
    }
  }

  /** "approved", "pending", "denied", or null for an unknown account. Admins are always approved. */
  const statusOf = (email) => (isAdmin(email) ? "approved" : db.getUser(email)?.status ?? null);

  const fail = (res, msg) => res.redirect(`/login.html?error=${encodeURIComponent(msg)}`);
  const DECLINED = "Your access request was declined. Ask an admin if you think this is a mistake.";

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
      if (!normalized || !email_verified) return fail(res, "That Google account has no verified email address");
      const user = db.recordSignIn(normalized, { name: name ?? email, picture: picture ?? null }, { admin: isAdmin(normalized) });
      if (statusOf(normalized) === "denied") return fail(res, DECLINED);
      if (user.status === "pending" && !isAdmin(normalized)) console.log(`Access request from ${normalized} is waiting for approval`);
      const session = { email: normalized, name: user.name, picture: user.picture, exp: Date.now() + SESSION_DAYS * 864e5 };
      const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
      cookie(res, SESSION_COOKIE, `${payload}.${sign(payload)}`, SESSION_DAYS * 86400);
      res.redirect(statusOf(normalized) === "approved" ? "/" : "/pending.html");
    } catch (err) {
      console.error("Google sign-in failed:", err.message);
      fail(res, "Google sign-in failed, please try again");
    }
  });

  app.post("/auth/logout", (req, res) => {
    cookie(res, SESSION_COOKIE, "", 0);
    res.status(204).end();
  });

  // Gate everything else: approved users get through; pending users only see the
  // pending page; declined or unknown users are signed out.
  app.use((req, res, next) => {
    if (PUBLIC_PATHS.has(req.path)) return next();
    const session = readSession(req);
    const status = session && statusOf(session.email);
    const isApi = req.path.startsWith("/api/");
    if (status === "approved" || (status === "pending" && PENDING_PATHS.has(req.path))) {
      req.user = { ...session, status, isAdmin: isAdmin(session.email) };
      return next();
    }
    if (status === "pending") {
      return isApi ? res.status(403).json({ error: "Your access request is waiting for approval", pending: true }) : res.redirect("/pending.html");
    }
    if (session) cookie(res, SESSION_COOKIE, "", 0); // declined, or removed from the database
    if (isApi) return res.status(401).json({ error: "Sign in required" });
    if (status === "denied") return fail(res, DECLINED);
    res.redirect("/login.html");
  });

  app.get("/api/me", (req, res) =>
    res.json({ email: req.user.email, name: req.user.name, picture: req.user.picture, status: req.user.status, isAdmin: req.user.isAdmin }),
  );

  // ---------- admin: review sign-up requests ----------

  const requireAdmin = (req, res, next) => {
    if (req.user.isAdmin) return next();
    if (req.path.startsWith("/api/")) return res.status(403).json({ error: "Admins only" });
    res.redirect("/");
  };
  app.get("/admin.html", requireAdmin);

  app.get("/api/admin/users", requireAdmin, (req, res) => {
    res.json(db.listUsers().map((u) => ({ ...u, isAdmin: isAdmin(u.email) })));
  });

  app.get("/api/admin/pending-count", requireAdmin, (req, res) => res.json({ count: db.countPending() }));

  app.post("/api/admin/users/:email", requireAdmin, (req, res) => {
    const email = String(req.params.email).toLowerCase();
    const status = req.body?.status;
    if (!["approved", "denied"].includes(status)) return res.status(400).json({ error: 'status must be "approved" or "denied"' });
    if (isAdmin(email)) return res.status(400).json({ error: "Admins are set in ADMIN_EMAILS and can't be changed here" });
    if (!db.getUser(email)) return res.status(404).json({ error: "No such user" });
    const user = db.setUserStatus(email, status, req.user.email);
    console.log(`${req.user.email} ${status === "approved" ? "approved" : "declined"} ${email}`);
    res.json({ ...user, isAdmin: false });
  });

  console.log(`Google sign-in enabled. Admins: ${admins.join(", ")} (redirect URI: ${redirectUri})`);
  return { admins };
}
