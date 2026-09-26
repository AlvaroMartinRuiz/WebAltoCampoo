import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- Sesión de administrador ----------
// Cookie firmada con HMAC: "<expiración>.<firma>". No hace falta guardar sesiones en la BD.

const COOKIE = "vac_admin";
const SESSION_HOURS = 12;

const sha256 = (s) => createHash("sha256").update(s).digest();

export function createAuth({ password, secret = randomBytes(32).toString("hex"), secureCookie = false }) {
  const sign = (payload) => createHmac("sha256", secret).update(payload).digest("base64url");

  function checkPassword(candidate) {
    return typeof candidate === "string" && timingSafeEqual(sha256(candidate), sha256(password));
  }

  function issue(res) {
    const exp = String(Date.now() + SESSION_HOURS * 3_600_000);
    res.cookie(COOKIE, `${exp}.${sign(exp)}`, {
      httpOnly: true, sameSite: "strict", secure: secureCookie, path: "/api/admin", maxAge: SESSION_HOURS * 3_600_000,
    });
  }

  function clear(res) {
    res.clearCookie(COOKIE, { path: "/api/admin" });
  }

  function isValid(req) {
    const raw = parseCookies(req.headers.cookie)[COOKIE];
    if (!raw) return false;
    const [exp, sig] = raw.split(".");
    if (!exp || !sig) return false;
    const expected = Buffer.from(sign(exp));
    const given = Buffer.from(sig);
    return given.length === expected.length && timingSafeEqual(given, expected) && Number(exp) > Date.now();
  }

  function requireAdmin(req, _res, next) {
    if (!isValid(req)) return next(new HttpError(401, "Sesión caducada. Vuelve a entrar."));
    next();
  }

  return { checkPassword, issue, clear, isValid, requireAdmin };
}

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---------- Límite de peticiones (en memoria, por IP) ----------

export function rateLimit({ windowMs, max, message = "Demasiadas peticiones. Espera un momento." }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs).unref();

  return (req, _res, next) => {
    const now = Date.now();
    let entry = hits.get(req.ip);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(req.ip, entry);
    }
    if (++entry.count > max) return next(new HttpError(429, message));
    next();
  };
}

// ---------- Cabeceras de seguridad ----------

export function securityHeaders(_req, res, next) {
  res.set({
    "Content-Security-Policy": [
      "default-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      "style-src-attr 'unsafe-inline'", // barras de ocupación del panel
      "font-src https://fonts.gstatic.com",
      "img-src 'self' data:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
  });
  next();
}
