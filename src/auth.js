import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_USERNAME = 'admin';
const DEFAULT_PASSWORD = 'gridvis2mqtt';
const SESSION_COOKIE = 'gridvis2mqtt_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const authPath = process.env.GRIDVIS2MQTT_AUTH_FILE
  || fileURLToPath(new URL('../data/auth.local.json', import.meta.url));

let authStore = null;
const sessions = new Map();

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return {
    salt,
    hash: scryptSync(String(password), salt, 64).toString('hex')
  };
}

function defaultAuthStore() {
  const credentials = hashPassword(DEFAULT_PASSWORD);
  return {
    version: 2,
    users: [{
      id: 'admin',
      username: DEFAULT_USERNAME,
      passwordSalt: credentials.salt,
      passwordHash: credentials.hash,
      role: 'admin',
      enabled: true,
      mustChangePassword: true,
      createdAt: new Date().toISOString()
    }],
    createdAt: new Date().toISOString()
  };
}

function migrateStore(parsed) {
  if (Array.isArray(parsed?.users)) {
    const users = parsed.users.filter((user) => user && user.username && user.passwordHash && user.passwordSalt).map((user, index) => ({
      id: String(user.id || (index === 0 ? 'admin' : `user-${index + 1}`)),
      username: String(user.username),
      passwordSalt: String(user.passwordSalt),
      passwordHash: String(user.passwordHash),
      role: user.role === 'admin' ? 'admin' : 'user',
      enabled: user.enabled !== false,
      mustChangePassword: user.mustChangePassword === true,
      createdAt: user.createdAt || new Date().toISOString(),
      passwordChangedAt: user.passwordChangedAt || undefined
    }));
    if (!users.length) throw new Error('Keine gültigen Benutzer vorhanden.');
    return { version: 2, users, createdAt: parsed.createdAt || new Date().toISOString() };
  }

  // Version 1 stored one set of credentials at the root. Keep existing
  // installations usable and convert them to the multi-user format.
  if (parsed?.username && parsed?.passwordHash && parsed?.passwordSalt) {
    return {
      version: 2,
      users: [{
        id: 'admin',
        username: String(parsed.username),
        passwordSalt: String(parsed.passwordSalt),
        passwordHash: String(parsed.passwordHash),
        role: 'admin',
        enabled: true,
        mustChangePassword: parsed.mustChangePassword === true,
        createdAt: parsed.createdAt || new Date().toISOString(),
        passwordChangedAt: parsed.passwordChangedAt || undefined
      }],
      createdAt: parsed.createdAt || new Date().toISOString()
    };
  }
  throw new Error('Ungültige Authentifizierungsdatei.');
}

function writeAuthStore() {
  mkdirSync(dirname(authPath), { recursive: true });
  writeFileSync(authPath, `${JSON.stringify(authStore, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(authPath, 0o600);
}

function readAuthStore() {
  if (authStore) return authStore;
  try {
    const parsed = JSON.parse(readFileSync(authPath, 'utf8'));
    authStore = migrateStore(parsed);
    if (parsed.version !== 2 || !Array.isArray(parsed.users)) writeAuthStore();
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Authentifizierungsdatei konnte nicht gelesen werden: ${error.message}`);
    authStore = defaultAuthStore();
    writeAuthStore();
  }
  return authStore;
}

function findUserById(userId) {
  return readAuthStore().users.find((user) => user.id === String(userId)) || null;
}

function findUserByUsername(username) {
  const candidate = String(username || '').trim().toLowerCase();
  return readAuthStore().users.find((user) => user.username.toLowerCase() === candidate) || null;
}

function publicUser(user) {
  return user ? {
    id: user.id,
    username: user.username,
    role: user.role,
    enabled: user.enabled !== false,
    mustChangePassword: user.mustChangePassword === true,
    createdAt: user.createdAt || null,
    passwordChangedAt: user.passwordChangedAt || null
  } : null;
}

function validateUsername(username) {
  const value = String(username || '').trim();
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(value)) {
    throw new Error('Der Benutzername muss 3 bis 64 Zeichen lang sein und darf nur Buchstaben, Zahlen, Punkt, Unterstrich oder Bindestrich enthalten.');
  }
  return value;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Das Passwort muss mindestens 8 Zeichen lang sein.');
  }
}

function verifyPassword(user, password) {
  if (!user || typeof password !== 'string') return false;
  const derived = Buffer.from(scryptSync(password, user.passwordSalt, 64).toString('hex'), 'utf8');
  const expected = Buffer.from(String(user.passwordHash), 'utf8');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export function authFile() {
  return authPath;
}

export function authDefaults() {
  return { username: DEFAULT_USERNAME, password: DEFAULT_PASSWORD };
}

export function authStatus(request) {
  const session = getSession(request);
  const user = session?.userId ? findUserById(session.userId) : findUserByUsername(session?.username);
  return {
    authenticated: Boolean(session && user),
    userId: user?.id || null,
    username: user?.username || null,
    role: user?.role || null,
    mustChangePassword: Boolean(user?.mustChangePassword)
  };
}

export function authenticateCredentials(username, password) {
  const user = findUserByUsername(username);
  return user?.enabled !== false && verifyPassword(user, password) ? user : null;
}

export function verifyCredentials(username, password) {
  return Boolean(authenticateCredentials(username, password));
}

export function verifyUserPassword(userId, password) {
  return verifyPassword(findUserById(userId), password);
}

export function changePassword(password, userId = null) {
  validatePassword(password);
  const store = readAuthStore();
  const target = findUserById(userId) || store.users[0];
  if (!target) throw new Error('Benutzer nicht gefunden.');
  const credentials = hashPassword(password);
  authStore = {
    ...store,
    users: store.users.map((user) => user.id === target.id ? {
      ...user,
      passwordSalt: credentials.salt,
      passwordHash: credentials.hash,
      mustChangePassword: false,
      passwordChangedAt: new Date().toISOString()
    } : user)
  };
  writeAuthStore();
}

export function updateOwnProfile({ userId, username, password }) {
  const store = readAuthStore();
  const target = findUserById(userId);
  if (!target) throw new Error('Benutzer nicht gefunden.');
  const nextUsername = username === undefined ? target.username : validateUsername(username);
  const duplicate = store.users.find((user) => user.id !== target.id && user.username.toLowerCase() === nextUsername.toLowerCase());
  if (duplicate) throw new Error('Dieser Benutzername ist bereits vergeben.');
  let updated = { ...target, username: nextUsername };
  if (password !== undefined && password !== '') {
    validatePassword(password);
    const credentials = hashPassword(password);
    updated = {
      ...updated,
      passwordSalt: credentials.salt,
      passwordHash: credentials.hash,
      mustChangePassword: false,
      passwordChangedAt: new Date().toISOString()
    };
  }
  authStore = { ...store, users: store.users.map((user) => user.id === target.id ? updated : user) };
  writeAuthStore();
  return publicUser(updated);
}

export function listUsers() {
  return readAuthStore().users.map(publicUser);
}

export function createUser({ username, password, role = 'user' }) {
  const store = readAuthStore();
  const normalizedUsername = validateUsername(username);
  validatePassword(password);
  if (store.users.some((user) => user.username.toLowerCase() === normalizedUsername.toLowerCase())) {
    throw new Error('Dieser Benutzername ist bereits vergeben.');
  }
  const credentials = hashPassword(password);
  const user = {
    id: `user-${randomBytes(8).toString('hex')}`,
    username: normalizedUsername,
    passwordSalt: credentials.salt,
    passwordHash: credentials.hash,
    role: role === 'admin' ? 'admin' : 'user',
    enabled: true,
    mustChangePassword: false,
    createdAt: new Date().toISOString(),
    passwordChangedAt: new Date().toISOString()
  };
  authStore = { ...store, users: [...store.users, user] };
  writeAuthStore();
  return publicUser(user);
}

export function resetUserPassword(userId, password) {
  validatePassword(password);
  const user = findUserById(userId);
  if (!user) throw new Error('Benutzer nicht gefunden.');
  const credentials = hashPassword(password);
  const store = readAuthStore();
  authStore = {
    ...store,
    users: store.users.map((entry) => entry.id === user.id ? {
      ...entry,
      passwordSalt: credentials.salt,
      passwordHash: credentials.hash,
      mustChangePassword: true,
      passwordChangedAt: new Date().toISOString()
    } : entry)
  };
  writeAuthStore();
  return publicUser(findUserById(user.id));
}

export function deleteUser(userId) {
  const store = readAuthStore();
  const target = findUserById(userId);
  if (!target) throw new Error('Benutzer nicht gefunden.');
  if (store.users.length <= 1) throw new Error('Der letzte Benutzer kann nicht gelöscht werden.');
  if (target.role === 'admin' && store.users.filter((user) => user.role === 'admin' && user.enabled !== false).length <= 1) {
    throw new Error('Der letzte Administrator kann nicht gelöscht werden.');
  }
  authStore = { ...store, users: store.users.filter((user) => user.id !== target.id) };
  for (const [token, session] of sessions) if (session.userId === target.id) sessions.delete(token);
  writeAuthStore();
}

function parseCookies(request) {
  return String(request.headers.cookie || '').split(';').reduce((cookies, part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return cookies;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

export function getSession(request) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  const user = findUserById(session.userId) || findUserByUsername(session.username);
  if (!user || user.enabled === false) {
    sessions.delete(token);
    return null;
  }
  session.userId = user.id;
  session.username = user.username;
  session.role = user.role;
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

export function createSession(userOrUsername) {
  const user = typeof userOrUsername === 'object'
    ? userOrUsername
    : findUserByUsername(userOrUsername);
  const token = randomBytes(32).toString('hex');
  sessions.set(token, {
    userId: user?.id || '',
    username: String(user?.username || userOrUsername),
    role: user?.role || 'user',
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

export function clearSession(request) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (token) sessions.delete(token);
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function requireAuthenticated(request, { allowPasswordChange = false } = {}) {
  const session = getSession(request);
  if (!session) return { ok: false, status: 401, error: 'Anmeldung erforderlich.', code: 'AUTH_REQUIRED' };
  const user = findUserById(session.userId);
  if (!allowPasswordChange && user?.mustChangePassword) {
    return { ok: false, status: 403, error: 'Bitte zuerst das Startpasswort ändern.', code: 'PASSWORD_CHANGE_REQUIRED' };
  }
  return { ok: true, session, user: publicUser(user) };
}

export function requireAdmin(request) {
  const auth = requireAuthenticated(request);
  if (!auth.ok) return auth;
  if (auth.user?.role !== 'admin') return { ok: false, status: 403, error: 'Administratorrechte erforderlich.', code: 'ADMIN_REQUIRED' };
  return auth;
}
