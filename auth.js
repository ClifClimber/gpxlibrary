'use strict';
// JWT simple con node:crypto (HMAC-SHA256). Sin dependencias externas.
// Cookie: gpx_session (httpOnly, SameSite=Lax).
const crypto = require('crypto');

const SECRET = process.env.JWT_SECRET || (() => {
  // Genera un secreto aleatorio en memoria si no está configurado.
  // En producción definir JWT_SECRET en .env para que las sesiones sobrevivan reinicios.
  const s = crypto.randomBytes(48).toString('base64');
  console.warn('[auth] JWT_SECRET no configurado — usando clave temporal (sesiones no sobrevivirán reinicios)');
  return s;
})();

const COOKIE_NAME = 'gpx_session';
const TTL_SECONDS = 7 * 24 * 3600; // 7 días

// ── JWT mínimo (header.payload.sig, base64url) ──────────────────────
function b64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, ''); }
function sign(payload) {
  const header  = b64url(Buffer.from('{"alg":"HS256","typ":"JWT"}'));
  const body    = b64url(Buffer.from(JSON.stringify(payload)));
  const sig     = b64url(crypto.createHmac('sha256', SECRET).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}
function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = b64url(crypto.createHmac('sha256', SECRET).update(`${parts[0]}.${parts[1]}`).digest());
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[2]))) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    if (p.exp && Date.now() / 1000 > p.exp) return null;
    return p;
  } catch { return null; }
}

// ── Cookie ──────────────────────────────────────────────────────────
function setCookie(res, token) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${TTL_SECONDS}`);
}
function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}
function parseCookie(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === COOKIE_NAME) return rest.join('=');
  }
  return null;
}

// ── Tokens de sesión ────────────────────────────────────────────────
function createToken(user) {
  return sign({ sub: user.id, username: user.username, role: user.role, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + TTL_SECONDS });
}

// ── Middleware: lee la cookie y adjunta req.user (o null) ────────────
function authMiddleware(req) {
  const token = parseCookie(req);
  req.user = verify(token);
}

// ── Guards ──────────────────────────────────────────────────────────
function requireAuth(req, res) {
  if (!req.user) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'No autenticado' })); return false; }
  return true;
}
function requireAdmin(req, res) {
  if (!req.user) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'No autenticado' })); return false; }
  if (req.user.role !== 'admin') { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Se requiere rol administrador' })); return false; }
  return true;
}

// ── Hash de contraseña (pbkdf2, sin bcrypt) ─────────────────────────
const HASH_ITERATIONS = 100000;
const HASH_KEYLEN     = 64;
const HASH_DIGEST     = 'sha512';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key  = crypto.pbkdf2Sync(password, salt, HASH_ITERATIONS, HASH_KEYLEN, HASH_DIGEST).toString('hex');
  return `${salt}:${key}`;
}
function checkPassword(password, stored) {
  const [salt, key] = stored.split(':');
  const attempt = crypto.pbkdf2Sync(password, salt, HASH_ITERATIONS, HASH_KEYLEN, HASH_DIGEST).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(key, 'hex'), Buffer.from(attempt, 'hex'));
}

module.exports = { createToken, setCookie, clearCookie, authMiddleware, requireAuth, requireAdmin, hashPassword, checkPassword };
