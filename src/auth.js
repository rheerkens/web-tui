import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ACCESS_TTL_MS = 15 * 60 * 1000;
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_TTL_MS = 5 * 60 * 1000;
const ROTATION_GRACE_MS = 30 * 1000;
const ACCESS_COOKIE = 'waypoint_access';
const REFRESH_COOKIE = 'waypoint_refresh';
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

const randomToken = () => crypto.randomBytes(32).toString('base64url');
const digest = (value) => crypto.createHash('sha256').update(value).digest('base64url');
const safeEqual = (left, right) => {
  const a = Buffer.from(left || '');
  const b = Buffer.from(right || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').flatMap((part) => {
    const index = part.indexOf('=');
    if (index < 0) return [];
    try { return [[part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())]]; }
    catch { return []; }
  }));
}

function cookie(name, value, maxAge, secure) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAge / 1000)}${secure ? '; Secure' : ''}`;
}

function requestIsSecure(request) {
  if (process.env.AUTH_SECURE_COOKIES === 'true') return true;
  if (process.env.AUTH_SECURE_COOKIES === 'false') return false;
  return request.secure || request.socket?.encrypted === true || request.headers['x-forwarded-proto'] === 'https';
}

export function createAuth(options = {}) {
  const stateFile = options.stateFile === undefined
    ? (process.env.NODE_ENV === 'test' ? null : process.env.AUTH_STATE_FILE || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'waypoint-terminal', 'auth.json'))
    : options.stateFile;
  const issuerOnly = options.issuerOnly === true;
  const codeDirectory = stateFile ? `${stateFile}.codes` : null;
  const consumedLoginLinks = new Map();
  const sessions = new Map();
  const codeAttempts = new Map();
  let signingKey = randomToken();
  let loadedState = false;

  if (stateFile) {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      loadedState = true;
      if (typeof state.signingKey === 'string') signingKey = state.signingKey;
      for (const session of state.sessions || []) {
        if (session.expiresAt > Date.now()) sessions.set(session.id, session);
      }
      for (const link of state.consumedLoginLinks || []) {
        if (link.expiresAt > Date.now()) consumedLoginLinks.set(link.nonce, link.expiresAt);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  if (issuerOnly && !loadedState) {
    throw new Error(`Authentication state not found at ${stateFile || '(disabled)'}. Start Waypoint before generating a login link.`);
  }

  function persist() {
    if (!stateFile) return;
    fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${stateFile}.${process.pid}.tmp`;
    const consumed = [...consumedLoginLinks].map(([nonce, expiresAt]) => ({ nonce, expiresAt }));
    fs.writeFileSync(temporary, JSON.stringify({ signingKey, sessions: [...sessions.values()], consumedLoginLinks: consumed }), { mode: 0o600 });
    fs.renameSync(temporary, stateFile);
    fs.chmodSync(stateFile, 0o600);
  }

  // Ensure a stable signing key exists before the first browser session is issued.
  if (!issuerOnly) persist();

  function prune() {
    const now = Date.now();
    let changed = false;
    for (const [nonce, expiresAt] of consumedLoginLinks) {
      if (expiresAt <= now) { consumedLoginLinks.delete(nonce); changed = true; }
    }
    for (const [id, session] of sessions) {
      if (session.expiresAt <= now) { sessions.delete(id); changed = true; }
    }
    if (changed) persist();
  }

  function signAccess(sessionId) {
    const payload = Buffer.from(JSON.stringify({ sid: sessionId, exp: Date.now() + ACCESS_TTL_MS })).toString('base64url');
    const signature = crypto.createHmac('sha256', signingKey).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  function createCliToken() {
    const payload = Buffer.from(JSON.stringify({ purpose: 'cli', exp: Date.now() + 60 * 1000 })).toString('base64url');
    const signature = crypto.createHmac('sha256', signingKey).update(`cli.${payload}`).digest('base64url');
    return `${payload}.${signature}`;
  }

  function verifyCliToken(token) {
    if (!token) return false;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) return false;
    const expected = crypto.createHmac('sha256', signingKey).update(`cli.${payload}`).digest('base64url');
    if (!safeEqual(signature, expected)) return false;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
      return data.purpose === 'cli' && data.exp > Date.now() && data.exp <= Date.now() + 61 * 1000;
    } catch { return false; }
  }

  function verifyAccess(token) {
    if (!token) return null;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) return null;
    const expected = crypto.createHmac('sha256', signingKey).update(payload).digest('base64url');
    if (!safeEqual(signature, expected)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
      return data.exp > Date.now() && sessions.has(data.sid) ? data.sid : null;
    } catch { return null; }
  }

  function createSession() {
    const id = randomToken();
    const secret = randomToken();
    sessions.set(id, { id, tokenHash: digest(secret), previousHash: null, previousUntil: 0, expiresAt: Date.now() + REFRESH_TTL_MS });
    persist();
    return { id, secret };
  }

  function useRefresh(value, rotate = true) {
    if (!value) return null;
    const separator = value.indexOf('.');
    if (separator < 1) return null;
    const id = value.slice(0, separator);
    const secret = value.slice(separator + 1);
    const session = sessions.get(id);
    if (!session || session.expiresAt <= Date.now()) return null;
    const hash = digest(secret);
    const valid = safeEqual(hash, session.tokenHash)
      || (session.previousUntil > Date.now() && safeEqual(hash, session.previousHash));
    if (!valid) return null;

    // A WebSocket upgrade has no reliable way to replace browser cookies. It may
    // authenticate with the refresh token, but rotation is left to the next HTTP request.
    if (!rotate) return { id, secret };

    const nextSecret = randomToken();
    session.previousHash = session.tokenHash;
    session.previousUntil = Date.now() + ROTATION_GRACE_MS;
    session.tokenHash = digest(nextSecret);
    session.expiresAt = Date.now() + REFRESH_TTL_MS;
    persist();
    return { id, secret: nextSecret };
  }

  function setSessionCookies(request, response, session) {
    const secure = requestIsSecure(request);
    response.setHeader('Set-Cookie', [
      cookie(ACCESS_COOKIE, signAccess(session.id), ACCESS_TTL_MS, secure),
      cookie(REFRESH_COOKIE, `${session.id}.${session.secret}`, REFRESH_TTL_MS, secure)
    ]);
  }

  function clearCookies(request, response) {
    const secure = requestIsSecure(request);
    response.setHeader('Set-Cookie', [cookie(ACCESS_COOKIE, '', 0, secure), cookie(REFRESH_COOKIE, '', 0, secure)]);
  }

  function authenticate(request, response) {
    prune();
    const authorization = request.headers.authorization || '';
    if (authorization.startsWith('Bearer ') && verifyCliToken(authorization.slice(7))) return 'cli';
    const cookies = parseCookies(request.headers.cookie);
    const accessSession = verifyAccess(cookies[ACCESS_COOKIE]);
    if (accessSession) return accessSession;
    const refreshed = useRefresh(cookies[REFRESH_COOKIE], Boolean(response));
    if (!refreshed) return null;
    if (response) setSessionCookies(request, response, refreshed);
    return refreshed.id;
  }

  function middleware(request, response, next) {
    const sessionId = authenticate(request, response);
    if (sessionId) { request.authSessionId = sessionId; next(); return; }
    clearCookies(request, response);
    response.setHeader('Cache-Control', 'no-store');
    if (request.path.startsWith('/api/')) {
      response.status(401).json({ error: 'Authentication required. Open a fresh temporary sign-in link.' });
      return;
    }
    response.status(401).type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Sign in · Waypoint</title></head><body style="font:16px system-ui;background:#0b0d0c;color:#e8e8e3;display:grid;place-items:center;min-height:100vh;margin:0"><main style="width:min(34rem,calc(100% - 3rem));padding:2rem"><h1>Sign in required</h1><p>Enter a temporary login code, or open the full login URL. Credentials are single-use and expire after five minutes.</p><form method="post" action="/auth/code" style="display:flex;gap:.6rem;margin:1.5rem 0"><input name="code" required maxlength="16" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" aria-label="Temporary login code" placeholder="ABCD-EFGH-JKLM" style="min-width:0;flex:1;font:1.1rem monospace;padding:.8rem;border:1px solid #6f7771;border-radius:.4rem;background:#151916;color:#fff;text-transform:uppercase"><button style="padding:.8rem 1rem;border:0;border-radius:.4rem;background:#d7ff64;color:#0b0d0c;font-weight:700">Sign in</button></form><p>Run <code>npm run auth:link</code> on the server to create a credential.</p></main></body></html>`);
  }

  function createLoginToken() {
    if (!issuerOnly) prune();
    const payload = Buffer.from(JSON.stringify({ nonce: randomToken(), exp: Date.now() + LOGIN_TTL_MS })).toString('base64url');
    const signature = crypto.createHmac('sha256', signingKey).update(`login.${payload}`).digest('base64url');
    return `${payload}.${signature}`;
  }

  function createLoginLink(baseUrl) {
    const token = createLoginToken();
    return `${baseUrl.replace(/\/$/, '')}/auth/login?token=${encodeURIComponent(token)}`;
  }

  function normalizeCode(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function displayCode(code) {
    return code.match(/.{1,4}/g).join('-');
  }

  function pruneCodeFiles() {
    if (!codeDirectory) return;
    let files;
    try { files = fs.readdirSync(codeDirectory); } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const file of files) {
      const filePath = path.join(codeDirectory, file);
      try {
        const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!Number.isFinite(record.expiresAt) || record.expiresAt <= Date.now()) fs.rmSync(filePath, { force: true });
      } catch { fs.rmSync(filePath, { force: true }); }
    }
  }

  function createLoginCredentials(baseUrl) {
    if (!codeDirectory) throw new Error('Short login codes require a persistent AUTH_STATE_FILE.');
    pruneCodeFiles();
    const token = createLoginToken();
    const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    fs.mkdirSync(codeDirectory, { recursive: true, mode: 0o700 });
    let code;
    while (!code) {
      const candidate = Array.from(crypto.randomBytes(12), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
      const filePath = path.join(codeDirectory, digest(candidate));
      try {
        fs.writeFileSync(filePath, JSON.stringify({ token, expiresAt: payload.exp }), { mode: 0o600, flag: 'wx' });
        code = candidate;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    return {
      url: `${baseUrl.replace(/\/$/, '')}/auth/login?token=${encodeURIComponent(token)}`,
      code: displayCode(code)
    };
  }

  function consumeLoginToken(token) {
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) return false;
    const expected = crypto.createHmac('sha256', signingKey).update(`login.${payload}`).digest('base64url');
    if (!safeEqual(signature, expected)) return false;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
      const valid = typeof data.nonce === 'string'
        && data.nonce.length >= 32
        && Number.isFinite(data.exp)
        && data.exp > Date.now()
        && data.exp <= Date.now() + LOGIN_TTL_MS + 1000
        && !consumedLoginLinks.has(data.nonce);
      if (!valid) return false;
      consumedLoginLinks.set(data.nonce, data.exp);
      persist();
      return true;
    } catch { return false; }
  }

  function login(request, response) {
    const token = typeof request.query.token === 'string' ? request.query.token : '';
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (!consumeLoginToken(token)) {
      response.status(401).type('html').send('<h1>Sign-in link invalid, expired, or already used</h1><p>Run <code>npm run auth:link</code> on the server to create a fresh five-minute link.</p>');
      return;
    }
    const session = createSession();
    setSessionCookies(request, response, session);
    response.redirect(303, '/');
  }

  function loginWithCode(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const client = request.ip || request.socket?.remoteAddress || 'unknown';
    const previous = codeAttempts.get(client);
    const attempts = !previous || previous.resetAt <= Date.now()
      ? { count: 1, resetAt: Date.now() + LOGIN_TTL_MS }
      : { ...previous, count: previous.count + 1 };
    codeAttempts.set(client, attempts);
    if (attempts.count > 10) {
      response.status(429).type('html').send('<h1>Too many attempts</h1><p>Wait five minutes before trying another login code.</p>');
      return;
    }

    const code = normalizeCode(request.body?.code);
    if (code.length !== 12 || !codeDirectory) {
      response.status(401).type('html').send('<h1>Invalid or expired login code</h1><p>Return to Waypoint and try a new code.</p>');
      return;
    }
    const filePath = path.join(codeDirectory, digest(code));
    const claimedPath = `${filePath}.${process.pid}.${randomToken()}.claimed`;
    let record;
    try {
      fs.renameSync(filePath, claimedPath);
      record = JSON.parse(fs.readFileSync(claimedPath, 'utf8'));
    } catch {
      response.status(401).type('html').send('<h1>Invalid or expired login code</h1><p>Return to Waypoint and try a new code.</p>');
      return;
    } finally {
      fs.rmSync(claimedPath, { force: true });
    }
    if (record.expiresAt <= Date.now() || !consumeLoginToken(record.token)) {
      response.status(401).type('html').send('<h1>Invalid or expired login code</h1><p>Return to Waypoint and request a new code.</p>');
      return;
    }
    codeAttempts.delete(client);
    const session = createSession();
    setSessionCookies(request, response, session);
    response.redirect(303, '/');
  }

  function logout(request, response) {
    const cookies = parseCookies(request.headers.cookie);
    const refresh = cookies[REFRESH_COOKIE] || '';
    const id = refresh.slice(0, refresh.indexOf('.'));
    if (id) { sessions.delete(id); persist(); }
    clearCookies(request, response);
    response.status(204).end();
  }

  return { middleware, authenticate, createCliToken, createLoginLink, createLoginCredentials, login, loginWithCode, logout };
}

export const authDurations = { access: ACCESS_TTL_MS, refresh: REFRESH_TTL_MS, login: LOGIN_TTL_MS };
