// 友達チャット: Cloudflare Worker 本体
// 画面（public フォルダ）の配信は Cloudflare が自動で行います。
// このファイルは /api/* と /ws だけを担当します。
//
// 必要な「秘密の値」（Cloudflare の画面で設定します。コードには書きません）
//   INVITE_CODE     … 友達が新規登録するときの招待コード
//   ADMIN_USERNAME  … 管理者になる人のユーザー名（例: yuu）
//   RECOVERY_CODE   … 管理者の登録時と、管理者がパスワードを忘れたときに使う回復用の合言葉
import { ChatRoom } from './chat-room.js';

export { ChatRoom };

const SESSION_COOKIE = 'session';
const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 30; // ログインの有効期間: 30日
const PBKDF2_ITERATIONS = 100000; // Cloudflare Workers で使える上限
const USERNAME_PATTERN = /^[\p{L}\p{N}_-]{2,20}$/u;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;
const MESSAGE_MAX = 2000;
const PAGE_SIZE = 50;
const TEMP_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/ws') {
        return await handleWebSocket(request, env, url);
      }
      if (url.pathname.startsWith('/api/')) {
        return await handleApi(request, env, ctx, url);
      }
      return await env.ASSETS.fetch(request);
    } catch (err) {
      console.error('Unhandled error:', err && err.stack ? err.stack : err);
      return fail(500, 'サーバーでエラーが発生しました。しばらくしてからもう一度お試しください。');
    }
  },
};

async function handleApi(request, env, ctx, url) {
  const method = request.method;
  const path = url.pathname;

  // 他のサイトからの書き込み操作は受け付けません
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) {
      return fail(403, '不正なリクエストです。');
    }
  }

  await ensureSchema(env);

  if (path === '/api/me' && method === 'GET') return handleMe(request, env);
  if (path === '/api/register' && method === 'POST') return handleRegister(request, env, url);
  if (path === '/api/login' && method === 'POST') return handleLogin(request, env, url);
  if (path === '/api/logout' && method === 'POST') return handleLogout(request, env, url);
  if (path === '/api/change-password' && method === 'POST') return handleChangePassword(request, env);
  if (path === '/api/admin/recover' && method === 'POST') return handleAdminRecover(request, env);
  if (path === '/api/rooms' && method === 'GET') return handleRooms(request, env);
  if (path === '/api/admin/users' && method === 'GET') return handleAdminUsers(request, env);

  let match = path.match(/^\/api\/rooms\/(\d+)\/messages$/);
  if (match) {
    const roomId = Number.parseInt(match[1], 10);
    if (method === 'GET') return handleListMessages(request, env, url, roomId);
    if (method === 'POST') return handlePostMessage(request, env, ctx, roomId);
  }

  match = path.match(/^\/api\/admin\/users\/(\d+)\/reset-password$/);
  if (match && method === 'POST') {
    return handleAdminResetPassword(request, env, Number.parseInt(match[1], 10));
  }

  match = path.match(/^\/api\/admin\/users\/(\d+)\/disable$/);
  if (match && method === 'POST') {
    return handleAdminDisable(request, env, Number.parseInt(match[1], 10));
  }

  return fail(404, '見つかりませんでした。');
}

async function handleWebSocket(request, env, url) {
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('WebSocket での接続が必要です。', { status: 426 });
  }
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) {
    return new Response('Forbidden', { status: 403 });
  }

  await ensureSchema(env);
  const auth = await authenticate(request, env);
  if (auth.error) return auth.error;

  const roomId = Number.parseInt(url.searchParams.get('room') || '', 10);
  const room = Number.isInteger(roomId) ? await getRoom(env, auth.user, roomId) : null;
  if (!room) return fail(404, '部屋が見つかりません。');

  return roomStub(env, room.id).fetch(request);
}

// ---------------------------------------------------------------------------
// データベースの準備（最初のアクセスで、足りない表を自動で作ります）
// ---------------------------------------------------------------------------

let schemaPromise = null;

function ensureSchema(env) {
  if (!schemaPromise) {
    const now = Date.now();
    const statements = [
      `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT NOT NULL,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)`,
      `CREATE TABLE IF NOT EXISTS rooms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'group',
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_messages_room ON messages (room_id, id)`,
      `CREATE TABLE IF NOT EXISTS rate_limits (
        key TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        reset_at INTEGER NOT NULL
      )`,
      `INSERT INTO rooms (name, kind, created_at)
        SELECT '雑談', 'group', ${now}
        WHERE NOT EXISTS (SELECT 1 FROM rooms)`,
    ];
    schemaPromise = env.DB.batch(statements.map((sql) => env.DB.prepare(sql))).catch((err) => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

// ---------------------------------------------------------------------------
// 小さな道具
// ---------------------------------------------------------------------------

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

function fail(status, error, code) {
  return json({ error, code }, status);
}

async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : null;
  } catch (err) {
    return null;
  }
}

function str(value) {
  return typeof value === 'string' ? value : '';
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

function sessionCookie(token, maxAgeSec, url) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

function toBase64(bytes) {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function fromBase64(text) {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function randomHex(byteLength) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Bytes(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

async function sha256Hex(text) {
  const bytes = await sha256Bytes(text);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqualBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

// 文字列どうしを、比べる時間から中身が推測されにくい形で比べます
async function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || b === '') return false;
  const [hashA, hashB] = await Promise.all([sha256Bytes(a), sha256Bytes(b)]);
  return timingSafeEqualBytes(hashA, hashB);
}

function generateTempPassword() {
  const limit = 256 - (256 % TEMP_PASSWORD_ALPHABET.length);
  let result = '';
  while (result.length < 12) {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    for (const byte of bytes) {
      if (byte < limit && result.length < 12) {
        result += TEMP_PASSWORD_ALPHABET[byte % TEMP_PASSWORD_ALPHABET.length];
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// パスワード（そのまま保存せず、元に戻せない形に変えて保存します）
// ---------------------------------------------------------------------------

async function derivePasswordBits(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256),
  );
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await derivePasswordBits(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(bits)}`;
}

async function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
    const iterations = Number.parseInt(parts[1], 10);
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100000) return false;
    const salt = fromBase64(parts[2]);
    const expected = fromBase64(parts[3]);
    const actual = await derivePasswordBits(password, salt, iterations);
    return timingSafeEqualBytes(actual, expected);
  } catch (err) {
    return false;
  }
}

function validatePassword(password, username) {
  if (password.length < PASSWORD_MIN) return `パスワードは${PASSWORD_MIN}文字以上にしてください。`;
  if (password.length > PASSWORD_MAX) return `パスワードは${PASSWORD_MAX}文字以内にしてください。`;
  if (username && password.toLowerCase() === username.toLowerCase()) {
    return 'ユーザー名と同じパスワードは使えません。';
  }
  return null;
}

// ---------------------------------------------------------------------------
// 試行回数の制限（総当たりでパスワードや招待コードを探られないようにします）
// ---------------------------------------------------------------------------

// 制限を超えていたら true を返します
async function tooManyAttempts(env, key, limit, windowMs) {
  const now = Date.now();
  const row = await env.DB.prepare('SELECT count, reset_at FROM rate_limits WHERE key = ?').bind(key).first();
  if (!row || row.reset_at <= now) {
    await env.DB.prepare(
      'INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = 1, reset_at = excluded.reset_at',
    )
      .bind(key, now + windowMs)
      .run();
    return false;
  }
  if (row.count >= limit) return true;
  await env.DB.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').bind(key).run();
  return false;
}

function clearAttempts(env, key) {
  return env.DB.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run();
}

const TOO_MANY_MESSAGE = '試行回数が多すぎます。しばらく待ってからもう一度お試しください。';

// ---------------------------------------------------------------------------
// ログイン状態
// ---------------------------------------------------------------------------

function isAdminName(env, username) {
  const adminName = typeof env.ADMIN_USERNAME === 'string' ? env.ADMIN_USERNAME.trim().toLowerCase() : '';
  return adminName !== '' && username.toLowerCase() === adminName;
}

function publicUser(env, user) {
  return {
    id: user.id,
    username: user.username,
    isAdmin: isAdminName(env, user.username),
    mustChangePassword: user.mustChangePassword,
  };
}

async function createSession(env, userId, url) {
  const token = randomHex(32);
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM rate_limits WHERE reset_at < ?').bind(now),
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').bind(
      tokenHash,
      userId,
      now + SESSION_MAX_AGE_SEC * 1000,
      now,
    ),
  ]);
  return sessionCookie(token, SESSION_MAX_AGE_SEC, url);
}

async function getSession(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.must_change_password, u.disabled
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`,
  )
    .bind(tokenHash, Date.now())
    .first();
  if (!row || row.disabled) return null;
  return {
    tokenHash,
    user: { id: row.id, username: row.username, mustChangePassword: row.must_change_password === 1 },
  };
}

// ログインが必要な処理の前に呼びます。{ user } か { error } を返します。
async function authenticate(request, env, allowMustChange = false) {
  const session = await getSession(request, env);
  if (!session) return { error: fail(401, 'ログインが必要です。', 'unauthorized') };
  if (session.user.mustChangePassword && !allowMustChange) {
    return { error: fail(403, '先にパスワードを変更してください。', 'password_change_required') };
  }
  return { user: session.user, tokenHash: session.tokenHash };
}

async function authenticateAdmin(request, env) {
  const auth = await authenticate(request, env);
  if (auth.error) return auth;
  if (!isAdminName(env, auth.user.username)) {
    return { error: fail(403, '管理者だけが使える機能です。', 'forbidden') };
  }
  return auth;
}

// ---------------------------------------------------------------------------
// アカウント関係の API
// ---------------------------------------------------------------------------

async function handleMe(request, env) {
  const auth = await authenticate(request, env, true);
  if (auth.error) return auth.error;
  return json({ user: publicUser(env, auth.user) });
}

async function handleRegister(request, env, url) {
  const body = await readJson(request);
  if (!body) return fail(400, '入力が正しくありません。');

  const username = str(body.username).trim();
  const password = str(body.password);
  const inviteCode = str(body.inviteCode).trim();

  if (!env.INVITE_CODE) {
    return fail(500, 'サーバーの設定が終わっていません（INVITE_CODE が未設定です）。');
  }
  if (!USERNAME_PATTERN.test(username)) {
    return fail(400, 'ユーザー名は2〜20文字で、文字・数字・「_」「-」だけ使えます。');
  }
  const passwordProblem = validatePassword(password, username);
  if (passwordProblem) return fail(400, passwordProblem);

  if (await tooManyAttempts(env, `register:${clientIp(request)}`, 10, 15 * 60 * 1000)) {
    return fail(429, TOO_MANY_MESSAGE);
  }

  // 管理者のユーザー名で登録するときだけ、招待コードの代わりに「回復用の合言葉」が必要です。
  // （先に別の人が「管理者のユーザー名」を取ってしまうのを防ぐためです）
  const registeringAdmin = isAdminName(env, username);
  if (registeringAdmin && !env.RECOVERY_CODE) {
    return fail(500, 'サーバーの設定が終わっていません（RECOVERY_CODE が未設定です）。');
  }
  const expectedCode = registeringAdmin ? env.RECOVERY_CODE : env.INVITE_CODE;
  if (!(await safeEqual(inviteCode, expectedCode))) {
    return fail(403, '招待コードが違います。');
  }

  const taken = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (taken) return fail(409, 'そのユーザー名はすでに使われています。');

  const passwordHash = await hashPassword(password);
  let userId;
  try {
    const result = await env.DB.prepare(
      'INSERT INTO users (username, password_hash, must_change_password, disabled, created_at) VALUES (?, ?, 0, 0, ?)',
    )
      .bind(username, passwordHash, Date.now())
      .run();
    userId = result.meta.last_row_id;
  } catch (err) {
    if (String(err && err.message).includes('UNIQUE')) {
      return fail(409, 'そのユーザー名はすでに使われています。');
    }
    throw err;
  }

  const cookie = await createSession(env, userId, url);
  const user = { id: userId, username, mustChangePassword: false };
  return json({ user: publicUser(env, user) }, 201, { 'Set-Cookie': cookie });
}

async function handleLogin(request, env, url) {
  const body = await readJson(request);
  if (!body) return fail(400, '入力が正しくありません。');

  const username = str(body.username).trim();
  const password = str(body.password);
  if (!username || !password) return fail(400, 'ユーザー名とパスワードを入力してください。');

  const attemptKey = `login:${clientIp(request)}:${username.toLowerCase().slice(0, 40)}`;
  if (await tooManyAttempts(env, attemptKey, 10, 15 * 60 * 1000)) {
    return fail(429, TOO_MANY_MESSAGE);
  }

  const row = await env.DB.prepare(
    'SELECT id, username, password_hash, must_change_password, disabled FROM users WHERE username = ?',
  )
    .bind(username)
    .first();
  const passwordOk = row ? await verifyPassword(password, row.password_hash) : false;
  if (!row || !passwordOk) return fail(401, 'ユーザー名かパスワードが違います。');
  if (row.disabled) return fail(403, 'このアカウントは停止されています。管理者に連絡してください。');

  await clearAttempts(env, attemptKey);
  const cookie = await createSession(env, row.id, url);
  const user = { id: row.id, username: row.username, mustChangePassword: row.must_change_password === 1 };
  return json({ user: publicUser(env, user) }, 200, { 'Set-Cookie': cookie });
}

async function handleLogout(request, env, url) {
  const token = getCookie(request, SESSION_COOKIE);
  if (token && /^[0-9a-f]{64}$/.test(token)) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?')
      .bind(await sha256Hex(token))
      .run();
  }
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0, url) });
}

async function handleChangePassword(request, env) {
  const auth = await authenticate(request, env, true);
  if (auth.error) return auth.error;

  const body = await readJson(request);
  if (!body) return fail(400, '入力が正しくありません。');
  const currentPassword = str(body.currentPassword);
  const newPassword = str(body.newPassword);

  if (await tooManyAttempts(env, `chpw:${auth.user.id}`, 10, 15 * 60 * 1000)) {
    return fail(429, TOO_MANY_MESSAGE);
  }

  const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(auth.user.id).first();
  if (!row || !(await verifyPassword(currentPassword, row.password_hash))) {
    return fail(403, '今のパスワードが違います。');
  }
  const problem = validatePassword(newPassword, auth.user.username);
  if (problem) return fail(400, problem);
  if (newPassword === currentPassword) return fail(400, '今のパスワードと違うものにしてください。');

  const newHash = await hashPassword(newPassword);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').bind(
      newHash,
      auth.user.id,
    ),
    // 他の端末のログインは、安全のため解除します
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(auth.user.id, auth.tokenHash),
    env.DB.prepare('DELETE FROM rate_limits WHERE key = ?').bind(`chpw:${auth.user.id}`),
  ]);

  const user = { ...auth.user, mustChangePassword: false };
  return json({ user: publicUser(env, user) });
}

// 管理者がパスワードを忘れたとき: 回復用の合言葉で、新しいパスワードを決め直します
async function handleAdminRecover(request, env) {
  const body = await readJson(request);
  if (!body) return fail(400, '入力が正しくありません。');
  const recoveryCode = str(body.recoveryCode).trim();
  const newPassword = str(body.newPassword);

  if (!env.RECOVERY_CODE || !env.ADMIN_USERNAME) {
    return fail(500, 'サーバーの設定が終わっていません（RECOVERY_CODE または ADMIN_USERNAME が未設定です）。');
  }
  if (await tooManyAttempts(env, `recover:${clientIp(request)}`, 5, 15 * 60 * 1000)) {
    return fail(429, TOO_MANY_MESSAGE);
  }
  if (!(await safeEqual(recoveryCode, env.RECOVERY_CODE))) {
    return fail(403, '回復用の合言葉が違います。');
  }

  const admin = await env.DB.prepare('SELECT id, username FROM users WHERE username = ?')
    .bind(env.ADMIN_USERNAME.trim())
    .first();
  if (!admin) return fail(404, '管理者のアカウントがまだ登録されていません。新規登録から作ってください。');

  const problem = validatePassword(newPassword, admin.username);
  if (problem) return fail(400, problem);

  const newHash = await hashPassword(newPassword);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, disabled = 0 WHERE id = ?').bind(
      newHash,
      admin.id,
    ),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(admin.id),
  ]);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// 管理者用の API
// ---------------------------------------------------------------------------

async function handleAdminUsers(request, env) {
  const auth = await authenticateAdmin(request, env);
  if (auth.error) return auth.error;

  const { results } = await env.DB.prepare(
    'SELECT id, username, must_change_password, disabled, created_at FROM users ORDER BY id',
  ).all();
  const users = results.map((row) => ({
    id: row.id,
    username: row.username,
    isAdmin: isAdminName(env, row.username),
    mustChangePassword: row.must_change_password === 1,
    disabled: row.disabled === 1,
    createdAt: row.created_at,
  }));
  return json({ users });
}

async function handleAdminResetPassword(request, env, targetId) {
  const auth = await authenticateAdmin(request, env);
  if (auth.error) return auth.error;
  if (targetId === auth.user.id) {
    return fail(400, '自分のパスワードは「パスワード変更」から変えてください。');
  }

  const target = await env.DB.prepare('SELECT id, username FROM users WHERE id = ?').bind(targetId).first();
  if (!target) return fail(404, 'ユーザーが見つかりません。');

  const tempPassword = generateTempPassword();
  const hash = await hashPassword(tempPassword);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').bind(hash, target.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target.id),
  ]);
  return json({ username: target.username, tempPassword });
}

async function handleAdminDisable(request, env, targetId) {
  const auth = await authenticateAdmin(request, env);
  if (auth.error) return auth.error;
  if (targetId === auth.user.id) return fail(400, '自分のアカウントは停止できません。');

  const body = await readJson(request);
  if (!body || typeof body.disabled !== 'boolean') return fail(400, '入力が正しくありません。');

  const target = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(targetId).first();
  if (!target) return fail(404, 'ユーザーが見つかりません。');

  const statements = [
    env.DB.prepare('UPDATE users SET disabled = ? WHERE id = ?').bind(body.disabled ? 1 : 0, target.id),
  ];
  if (body.disabled) {
    statements.push(env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target.id));
  }
  await env.DB.batch(statements);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// 部屋とメッセージ
// ---------------------------------------------------------------------------

function roomStub(env, roomId) {
  return env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(`room-${roomId}`));
}

// 部屋に入れるかどうかの確認は、ここにまとめています。
// 今は「全員が全部の部屋に入れる」ので、部屋があるかどうかだけを見ています。
// 個人チャット（DM）を作るときは、ここで「参加者かどうか」も確認するようにします。
async function getRoom(env, user, roomId) {
  return env.DB.prepare('SELECT id, name, kind FROM rooms WHERE id = ?').bind(roomId).first();
}

async function handleRooms(request, env) {
  const auth = await authenticate(request, env);
  if (auth.error) return auth.error;
  const { results } = await env.DB.prepare('SELECT id, name, kind FROM rooms ORDER BY id').all();
  return json({ rooms: results });
}

async function handleListMessages(request, env, url, roomId) {
  const auth = await authenticate(request, env);
  if (auth.error) return auth.error;
  const room = await getRoom(env, auth.user, roomId);
  if (!room) return fail(404, '部屋が見つかりません。');

  const before = Number.parseInt(url.searchParams.get('before') || '', 10);
  const after = Number.parseInt(url.searchParams.get('after') || '', 10);
  const requested = Number.parseInt(url.searchParams.get('limit') || '', 10);
  const limit = Math.min(Math.max(Number.isInteger(requested) ? requested : PAGE_SIZE, 1), 100);

  const base =
    'SELECT m.id, m.room_id, m.user_id, u.username, m.content, m.created_at ' +
    'FROM messages m JOIN users u ON u.id = m.user_id WHERE m.room_id = ?';

  // 再接続したときに、取りこぼした新しいメッセージを取り戻す
  if (Number.isInteger(after)) {
    const { results } = await env.DB.prepare(`${base} AND m.id > ? ORDER BY m.id ASC LIMIT 200`)
      .bind(room.id, after)
      .all();
    return json({ messages: results, hasMore: false });
  }

  // 古いメッセージを読み込む／最初に最新のメッセージを読み込む
  let rows;
  if (Number.isInteger(before)) {
    const { results } = await env.DB.prepare(`${base} AND m.id < ? ORDER BY m.id DESC LIMIT ?`)
      .bind(room.id, before, limit + 1)
      .all();
    rows = results;
  } else {
    const { results } = await env.DB.prepare(`${base} ORDER BY m.id DESC LIMIT ?`)
      .bind(room.id, limit + 1)
      .all();
    rows = results;
  }
  const hasMore = rows.length > limit;
  if (hasMore) rows = rows.slice(0, limit);
  rows.reverse();
  return json({ messages: rows, hasMore });
}

async function handlePostMessage(request, env, ctx, roomId) {
  const auth = await authenticate(request, env);
  if (auth.error) return auth.error;
  const room = await getRoom(env, auth.user, roomId);
  if (!room) return fail(404, '部屋が見つかりません。');

  const body = await readJson(request);
  if (!body) return fail(400, '入力が正しくありません。');
  const content = str(body.content).replace(/\r\n/g, '\n').trim();
  if (!content) return fail(400, 'メッセージが空です。');
  if (content.length > MESSAGE_MAX) return fail(400, `メッセージは${MESSAGE_MAX}文字以内にしてください。`);

  const createdAt = Date.now();
  const result = await env.DB.prepare(
    'INSERT INTO messages (room_id, user_id, content, created_at) VALUES (?, ?, ?, ?)',
  )
    .bind(room.id, auth.user.id, content, createdAt)
    .run();

  const message = {
    id: result.meta.last_row_id,
    room_id: room.id,
    user_id: auth.user.id,
    username: auth.user.username,
    content,
    created_at: createdAt,
  };
  ctx.waitUntil(broadcast(env, room.id, message));
  return json({ message }, 201);
}

// 部屋につながっている全員に、新しいメッセージを届けます
async function broadcast(env, roomId, message) {
  try {
    await roomStub(env, roomId).fetch('https://chat-room/broadcast', {
      method: 'POST',
      body: JSON.stringify({ type: 'message', message }),
    });
  } catch (err) {
    console.error('broadcast failed:', err && err.stack ? err.stack : err);
  }
}
