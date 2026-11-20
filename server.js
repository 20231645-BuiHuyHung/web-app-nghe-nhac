/**
 * server.js – Backend Express cho ứng dụng nghe nhạc trực tuyến
 *
 * Chức năng:
 *  - REST API: bài hát, album, nghệ sĩ, playlist
 *  - Audio streaming theo HTTP Range (chunks) cho cả file upload lên server
 *    lẫn link mp3 online (proxy)
 *  - Upload bài hát mới (multipart/form-data)
 *  - Database SQLite (data/music.sqlite), tự nhập dữ liệu JSON cũ khi khởi động lần đầu
 *
 * Chạy: npm install && npm start  →  http://localhost:3000
 */

const express = require('express');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const multer = require('multer');
const initSqlJs = require('sql.js');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const { Readable } = require('stream');
const { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } = require('crypto');
const { isIP } = require('net');
const { rateLimit } = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const { z } = require('zod');

const ROOT = __dirname;
const DB_FILE = path.join(ROOT, 'data', 'music.sqlite');
const LEGACY_DB_FILE = path.join(ROOT, 'data', 'db.json');
const SEED_FILE = path.join(ROOT, 'data', 'seed.json');
const AUDIO_DIR = path.join(ROOT, 'uploads', 'audio');
const COVER_DIR = path.join(ROOT, 'uploads', 'covers');

fs.mkdirSync(AUDIO_DIR, { recursive: true });
fs.mkdirSync(COVER_DIR, { recursive: true });

/* ------------------------------------------------------------------ */
/* 1. DATABASE (SQLite)                                                */
/* ------------------------------------------------------------------ */

let sqlite;
let sqliteDatabase;
let db;
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL = 30 * 60 * 1000;
const SESSION_COOKIE = 'music_token';
let jwtSecret;
const passwordResetChallenges = new Map();
const PREMIUM_PLANS = Object.freeze({
  month: { months: 1, price: 49000 },
  halfYear: { months: 6, price: 269000 },
  year: { months: 12, price: 499000 },
});
const VNPAY_SANDBOX_URL = 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html';
const VNPAY_QUERY_URL = 'https://sandbox.vnpayment.vn/merchant_webapi/api/transaction';
const VNPAY_IPN_PATH = '/api/payments/vnpay/ipn';
const VNPAY_RETURN_PATH = '/api/payments/vnpay/return';

/* ------------------------------------------------------------------ */
/* ENVIRONMENT VALIDATION                                              */
/* ------------------------------------------------------------------ */

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  JWT_SECRET: z.string().min(32).optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_SECURE: z.enum(['true', 'false']).optional(),
  SMTP_FROM: z.string().max(254).optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  CORS_ORIGIN: z.string().url().optional(),
  APP_BASE_URL: z.string().url().optional(),
  VNPAY_TMN_CODE: z.string().optional(),
  VNPAY_HASH_SECRET: z.string().optional(),
  VNPAY_RETURN_URL: z.string().url().optional(),
  VNPAY_IPN_URL: z.string().url().optional(),
  VNPAY_QUERY_URL: z.string().url().optional(),
  MAX_AUDIO_SIZE_MB: z.coerce.number().int().positive().default(50),
  MAX_COVER_SIZE_MB: z.coerce.number().int().positive().default(5),
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production' && !env.JWT_SECRET) {
    ctx.addIssue({
      code: 'custom',
      path: ['JWT_SECRET'],
      message: 'JWT_SECRET bắt buộc trong môi trường production',
    });
  }
});

const env = EnvSchema.parse(process.env);
const isProduction = env.NODE_ENV === 'production';
const PORT = env.PORT;
const vnpayQueryUrl = env.NODE_ENV === 'test' && env.VNPAY_QUERY_URL
  ? env.VNPAY_QUERY_URL
  : VNPAY_QUERY_URL;

function isPublicHttpsUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return url.protocol === 'https:' &&
      hostname !== 'localhost' &&
      !hostname.endsWith('.localhost') &&
      isIP(hostname) === 0;
  } catch {
    return false;
  }
}

function vnpayConfiguration() {
  const appBaseUrl = (env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
  const returnUrl = env.VNPAY_RETURN_URL || `${appBaseUrl}${VNPAY_RETURN_PATH}`;
  const ipnUrl = env.VNPAY_IPN_URL || `${appBaseUrl}${VNPAY_IPN_PATH}`;
  const hasCredentials = Boolean(env.VNPAY_TMN_CODE && env.VNPAY_HASH_SECRET);
  const callbacksArePublic = isPublicHttpsUrl(appBaseUrl) &&
    isPublicHttpsUrl(returnUrl) &&
    isPublicHttpsUrl(ipnUrl);

  return {
    enabled: hasCredentials && callbacksArePublic,
    returnUrl,
    ipnUrl,
    message: !hasCredentials
      ? 'Điền VNPAY_TMN_CODE và VNPAY_HASH_SECRET trong .env để bật VNPay Sandbox.'
      : !callbacksArePublic
        ? 'APP_BASE_URL, Return URL và IPN URL phải dùng HTTPS và có thể truy cập công khai từ Internet.'
        : '',
  };
}

function vnpayEncode(value) {
  return encodeURIComponent(String(value)).replace(/%20/g, '+');
}

function vnpayCanonicalQuery(params) {
  return Object.keys(params)
    .filter((key) => key.startsWith('vnp_') && key !== 'vnp_SecureHash' && key !== 'vnp_SecureHashType')
    .sort()
    .filter((key) => params[key] !== undefined && params[key] !== null && String(params[key]) !== '')
    .map((key) => `${key}=${vnpayEncode(params[key])}`)
    .join('&');
}

function signVnpayParams(params, secret) {
  return createHmac('sha512', secret).update(vnpayCanonicalQuery(params), 'utf8').digest('hex');
}

function hasValidVnpaySignature(params, secret) {
  const received = typeof params.vnp_SecureHash === 'string' ? params.vnp_SecureHash.toLowerCase() : '';
  if (!/^[a-f0-9]{128}$/.test(received)) return false;
  const expected = signVnpayParams(params, secret);
  return timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'));
}

function vnpayQueryRequestSignature(params, secret) {
  const data = [
    params.vnp_RequestId,
    params.vnp_Version,
    params.vnp_Command,
    params.vnp_TmnCode,
    params.vnp_TxnRef,
    params.vnp_TransactionDate,
    params.vnp_CreateDate,
    params.vnp_IpAddr,
    params.vnp_OrderInfo,
  ].join('|');
  return createHmac('sha512', secret).update(data, 'utf8').digest('hex');
}

function hasValidVnpayQueryResponse(response, secret, tmnCode) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return false;
  const received = typeof response.vnp_SecureHash === 'string'
    ? response.vnp_SecureHash.toLowerCase()
    : '';
  if (!/^[a-f0-9]{128}$/.test(received)) return false;
  const data = [
    response.vnp_ResponseId,
    response.vnp_Command,
    response.vnp_ResponseCode,
    response.vnp_Message,
    tmnCode,
    response.vnp_TxnRef,
    response.vnp_Amount,
    response.vnp_BankCode,
    response.vnp_PayDate,
    response.vnp_TransactionNo,
    response.vnp_TransactionType,
    response.vnp_TransactionStatus,
    response.vnp_OrderInfo,
    response.vnp_PromotionCode,
    response.vnp_PromotionAmount,
  ].map((value) => value === undefined ? '' : String(value)).join('|');
  const expected = createHmac('sha512', secret).update(data, 'utf8').digest('hex');
  return timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'));
}

function vnpayParamsFromQuery(query) {
  return Object.fromEntries(Object.entries(query)
    .filter(([key, value]) => key.startsWith('vnp_') && typeof value === 'string')
  );
}

function vnpayDate(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}${values.hour}${values.minute}${values.second}`;
}

function requestClientIp(req) {
  let ip = String(req.ip || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (ip === '::1' || !isIP(ip)) ip = '127.0.0.1';
  return ip;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL, password_salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
    is_premium INTEGER NOT NULL DEFAULT 0 CHECK (is_premium IN (0, 1)),
    premium_expires_at TEXT,
    session_version INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS artists (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '', avatar TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS albums (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, artist_id INTEGER NOT NULL REFERENCES artists(id),
    year INTEGER NOT NULL, cover TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS songs (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, artist_id INTEGER NOT NULL REFERENCES artists(id),
    album_id INTEGER REFERENCES albums(id) ON DELETE SET NULL, genre TEXT NOT NULL DEFAULT 'Khác',
    duration REAL NOT NULL DEFAULT 0, audio_url TEXT NOT NULL, cover TEXT NOT NULL DEFAULT '',
    plays INTEGER NOT NULL DEFAULT 0, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    lyrics TEXT NOT NULL DEFAULT '',
    is_vip INTEGER NOT NULL DEFAULT 0 CHECK (is_vip IN (0, 1)),
    is_trending INTEGER NOT NULL DEFAULT 0 CHECK (is_trending IN (0, 1))
  );
  CREATE TABLE IF NOT EXISTS listening_history (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    user_name TEXT NOT NULL,
    user_email TEXT NOT NULL,
    song_id INTEGER NOT NULL,
    song_title TEXT NOT NULL,
    artist_name TEXT NOT NULL,
    played_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS playlist_songs (
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
    position INTEGER NOT NULL, PRIMARY KEY (playlist_id, song_id)
  );
  CREATE TABLE IF NOT EXISTS favorites (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, song_id)
  );
  CREATE TABLE IF NOT EXISTS premium_requests (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan TEXT NOT NULL CHECK (plan IN ('month', 'halfYear', 'year')),
    price INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at TEXT NOT NULL, reviewed_at TEXT, reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS vnpay_payments (
    id INTEGER PRIMARY KEY,
    premium_request_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    txn_ref TEXT NOT NULL UNIQUE,
    plan TEXT NOT NULL CHECK (plan IN ('month', 'halfYear', 'year')),
    amount INTEGER NOT NULL CHECK (amount > 0),
    currency TEXT NOT NULL DEFAULT 'VND',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed')),
    order_info TEXT NOT NULL,
    client_ip TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    response_code TEXT,
    transaction_status TEXT,
    transaction_no TEXT,
    bank_code TEXT,
    bank_tran_no TEXT,
    card_type TEXT,
    pay_date TEXT,
    callback_at TEXT,
    vip_activated INTEGER NOT NULL DEFAULT 0 CHECK (vip_activated IN (0, 1))
  );
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT
  );
  CREATE TABLE IF NOT EXISTS password_reset_requests (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at TEXT NOT NULL, reviewed_at TEXT, reviewed_by INTEGER
  );
  CREATE TABLE IF NOT EXISTS password_reset_codes (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL,
    code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS support_conversations (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'active', 'closed')),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS support_messages (
    id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender_type TEXT NOT NULL CHECK (sender_type IN ('user', 'admin')),
    body TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS genres (name TEXT NOT NULL PRIMARY KEY COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_songs_artist ON songs(artist_id);
  CREATE INDEX IF NOT EXISTS idx_songs_album ON songs(album_id);
  CREATE INDEX IF NOT EXISTS idx_songs_genre ON songs(genre);
  CREATE INDEX IF NOT EXISTS idx_listening_history_played_at ON listening_history(played_at);
  CREATE INDEX IF NOT EXISTS idx_listening_history_song_time ON listening_history(song_id, played_at);
  CREATE INDEX IF NOT EXISTS idx_playlists_user ON playlists(user_id);
  CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id);
  CREATE INDEX IF NOT EXISTS idx_premium_requests_user ON premium_requests(user_id);
  CREATE INDEX IF NOT EXISTS idx_premium_requests_status ON premium_requests(status);
  CREATE INDEX IF NOT EXISTS idx_vnpay_payments_user ON vnpay_payments(user_id, id);
  CREATE INDEX IF NOT EXISTS idx_vnpay_payments_status ON vnpay_payments(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_password_reset_requests_status ON password_reset_requests(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_password_reset_requests_user ON password_reset_requests(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_password_reset_codes_user ON password_reset_codes(user_id);
  CREATE INDEX IF NOT EXISTS idx_support_conversations_user_status ON support_conversations(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_support_conversations_status_updated ON support_conversations(status, updated_at);
  CREATE INDEX IF NOT EXISTS idx_support_messages_conversation_id ON support_messages(conversation_id, id);
`;

function createSqliteAdapter(database) {
  const bind = (statement, params) => {
    if (params === undefined) return;
    if (params && !Array.isArray(params)) {
      const named = {};
      for (const [key, value] of Object.entries(params)) {
        named[key.startsWith('@') || key.startsWith(':') || key.startsWith('$') ? key : `@${key}`] = value ?? null;
      }
      statement.bind(named);
    } else {
      statement.bind(params);
    }
  };

  return {
    database,
    exec: (sql) => database.exec(sql),
    prepare(sql) {
      return {
        run(params) {
          const statement = database.prepare(sql);
          try {
            bind(statement, params);
            statement.step();
          } finally {
            statement.free();
          }
        },
        get(params) {
          const statement = database.prepare(sql);
          try {
            bind(statement, params);
            return statement.step() ? statement.getAsObject() : undefined;
          } finally {
            statement.free();
          }
        },
        all(params) {
          const statement = database.prepare(sql);
          const rows = [];
          try {
            bind(statement, params);
            while (statement.step()) rows.push(statement.getAsObject());
            return rows;
          } finally {
            statement.free();
          }
        },
      };
    },
  };
}

function persistSqlite() {
  const temporaryFile = `${DB_FILE}.tmp`;
  fs.writeFileSync(temporaryFile, Buffer.from(sqliteDatabase.export()));
  fs.renameSync(temporaryFile, DB_FILE);
}

function loadDatabase() {
  const users = sqlite.prepare(`
    SELECT id, name, email, password_hash AS passwordHash, password_salt AS passwordSalt, role, status,
           is_premium AS isPremium, premium_expires_at AS premiumExpiresAt,
           session_version AS sessionVersion
    FROM users ORDER BY id
  `).all();
  const favorites = sqlite.prepare('SELECT user_id AS userId, song_id AS songId FROM favorites').all();
  const premiumRequests = sqlite.prepare(`
    SELECT id, user_id AS userId, plan, price, status, created_at AS createdAt,
           reviewed_at AS reviewedAt, reviewed_by AS reviewedBy
    FROM premium_requests ORDER BY id DESC
  `).all();
  const supportConversations = sqlite.prepare(`
    SELECT id, user_id AS userId, status, created_at AS createdAt,
           updated_at AS updatedAt, closed_at AS closedAt
    FROM support_conversations ORDER BY id
  `).all();
  const supportMessages = sqlite.prepare(`
    SELECT id, conversation_id AS conversationId, sender_id AS senderId,
           sender_type AS senderType, body, created_at AS createdAt
    FROM support_messages ORDER BY id
  `).all();
  const artists = sqlite.prepare('SELECT id, name, bio, avatar FROM artists ORDER BY id').all();
  const albums = sqlite.prepare('SELECT id, title, artist_id AS artistId, year, cover FROM albums ORDER BY id').all();
  const songs = sqlite.prepare(`
    SELECT id, title, artist_id AS artistId, album_id AS albumId, genre, duration,
           audio_url AS audioUrl, cover, plays, user_id AS userId, lyrics,
           is_vip AS isVip, is_trending AS isTrending
    FROM songs ORDER BY id
  `).all();
  const playlists = sqlite.prepare('SELECT id, name, user_id AS userId FROM playlists ORDER BY id').all();
  const playlistSongs = sqlite.prepare(`
    SELECT playlist_id AS playlistId, song_id AS songId
    FROM playlist_songs ORDER BY playlist_id, position
  `).all();
  for (const playlist of playlists) {
    playlist.songIds = playlistSongs
      .filter((item) => item.playlistId === playlist.id)
      .map((item) => item.songId);
  }
  const genres = sqlite.prepare('SELECT name FROM genres ORDER BY name COLLATE NOCASE').all().map((item) => item.name);
  return {
    users, artists, albums, songs, playlists, favorites, premiumRequests,
    supportConversations, supportMessages, genres,
  };
}

async function initializeDatabase() {
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const bytes = fs.existsSync(DB_FILE) ? fs.readFileSync(DB_FILE) : null;
  sqliteDatabase = new SQL.Database(bytes);
  sqlite = createSqliteAdapter(sqliteDatabase);
  sqlite.exec('PRAGMA foreign_keys = ON;');
  const premiumRequestsTableExists = Boolean(
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'premium_requests'").get()
  );
  const supportConversationsTableExists = Boolean(
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'support_conversations'").get()
  );
  const supportMessagesTableExists = Boolean(
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'support_messages'").get()
  );
  const passwordResetTokensTableExists = Boolean(
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'password_reset_tokens'").get()
  );
  const passwordResetRequestsTableExists = Boolean(
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'password_reset_requests'").get()
  );
  const vnpayPaymentsTableExists = Boolean(
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vnpay_payments'").get()
  );
  const listeningHistoryTableExists = Boolean(
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'listening_history'").get()
  );
  sqlite.exec(SCHEMA);
  let migratedColumns = !premiumRequestsTableExists || !supportConversationsTableExists ||
    !supportMessagesTableExists || !passwordResetTokensTableExists || !passwordResetRequestsTableExists ||
    !vnpayPaymentsTableExists || !listeningHistoryTableExists;
  const ensureColumn = (table, column, definition) => {
    const columns = sqlite.exec(`PRAGMA table_info(${table})`)[0]?.values || [];
    if (columns.some((row) => row[1] === column)) return;
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
    migratedColumns = true;
  };
  ensureColumn('users', 'is_premium', 'INTEGER NOT NULL DEFAULT 0 CHECK (is_premium IN (0, 1))');
  ensureColumn('users', 'premium_expires_at', 'TEXT');
  ensureColumn('users', 'session_version', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'phone', 'TEXT DEFAULT ""');
  ensureColumn('songs', 'is_vip', 'INTEGER NOT NULL DEFAULT 0 CHECK (is_vip IN (0, 1))');
  ensureColumn('songs', 'is_trending', 'INTEGER NOT NULL DEFAULT 0 CHECK (is_trending IN (0, 1))');
  ensureColumn('vnpay_payments', 'vip_activated', 'INTEGER NOT NULL DEFAULT 0 CHECK (vip_activated IN (0, 1))');
  if (migratedColumns) {
    persistSqlite();
    console.log('Đã cập nhật cấu trúc SQLite.');
  }
  const storedJwtSecret = sqlite.prepare("SELECT value FROM app_meta WHERE key = 'jwt_secret'").get();
  jwtSecret = process.env.JWT_SECRET || (storedJwtSecret && storedJwtSecret.value);
  if (!jwtSecret) {
    jwtSecret = randomBytes(32).toString('base64url');
    sqlite.prepare("INSERT INTO app_meta (key, value) VALUES ('jwt_secret', ?)").run([jwtSecret]);
    persistSqlite();
  }

  const migrationDone = sqlite.prepare("SELECT value FROM app_meta WHERE key = 'json_import_v1'").get();
  if (!migrationDone) {
    const legacyFile = fs.existsSync(LEGACY_DB_FILE) ? LEGACY_DB_FILE : SEED_FILE;
    const legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
    legacy.users ||= [];
    legacy.genres ||= [...new Set((legacy.songs || []).map((song) => song.genre).filter(Boolean))];
    legacy.users.forEach((user) => {
      user.role ||= 'user';
      user.status ||= 'active';
    });

    const count = sqlite.prepare('SELECT COUNT(*) AS count FROM users').get().count;
    const contentCount = sqlite.prepare('SELECT COUNT(*) AS count FROM songs').get().count +
      sqlite.prepare('SELECT COUNT(*) AS count FROM artists').get().count;
    if (count || contentCount) {
      throw new Error('SQLite đã có dữ liệu nhưng chưa đánh dấu nhập JSON; dừng để tránh ghi đè dữ liệu.');
    }

    sqlite.exec('BEGIN TRANSACTION;');
    try {
      const addUser = sqlite.prepare(`
        INSERT INTO users (id, name, email, password_hash, password_salt, role, status)
        VALUES (@id, @name, @email, @passwordHash, @passwordSalt, @role, @status)
      `);
      const addArtist = sqlite.prepare('INSERT INTO artists (id, name, bio, avatar) VALUES (@id, @name, @bio, @avatar)');
      const addAlbum = sqlite.prepare('INSERT INTO albums (id, title, artist_id, year, cover) VALUES (@id, @title, @artistId, @year, @cover)');
      const addSong = sqlite.prepare(`
        INSERT INTO songs (
          id, title, artist_id, album_id, genre, duration, audio_url, cover, plays, user_id, lyrics, is_vip, is_trending
        )
        VALUES (
          @id, @title, @artistId, @albumId, @genre, @duration, @audioUrl, @cover, @plays, @userId, @lyrics, @isVip, @isTrending
        )
      `);
      const addPlaylist = sqlite.prepare('INSERT INTO playlists (id, name, user_id) VALUES (@id, @name, @userId)');
      const addPlaylistSong = sqlite.prepare(`
        INSERT INTO playlist_songs (playlist_id, song_id, position) VALUES (@playlistId, @songId, @position)
      `);
      const addGenre = sqlite.prepare('INSERT OR IGNORE INTO genres (name) VALUES (?)');

      legacy.users.forEach((user) => addUser.run({
        ...user,
        passwordHash: user.passwordHash || '',
        passwordSalt: user.passwordSalt || '',
        role: user.role || 'user',
        status: user.status || 'active',
      }));
      (legacy.artists || []).forEach((artist) => addArtist.run({ bio: '', avatar: '', ...artist }));
      (legacy.albums || []).forEach((album) => addAlbum.run({ ...album, cover: album.cover || '' }));
      (legacy.songs || []).forEach((song) => {
        addSong.run({
          ...song,
          albumId: song.albumId ?? null,
          genre: song.genre || 'Khác',
          duration: Number(song.duration) || 0,
          plays: Number(song.plays) || 0,
          userId: song.userId ?? null,
          lyrics: song.lyrics || '',
          isVip: isBooleanFlag(song.isVip) ? 1 : 0,
          isTrending: isBooleanFlag(song.isTrending) ? 1 : 0,
        });
        if (song.genre) addGenre.run([song.genre]);
      });
      (legacy.playlists || []).forEach((playlist) => {
        addPlaylist.run({ id: playlist.id, name: playlist.name, userId: playlist.userId ?? null });
        (playlist.songIds || []).forEach((songId, position) => {
          addPlaylistSong.run({ playlistId: playlist.id, songId, position });
        });
      });
      legacy.genres.forEach((genre) => addGenre.run([genre]));
      sqlite.prepare("INSERT INTO app_meta (key, value) VALUES ('json_import_v1', ?)").run([new Date().toISOString()]);
      sqlite.exec('COMMIT;');
    } catch (error) {
      sqlite.exec('ROLLBACK;');
      throw error;
    }
    persistSqlite();
    console.log(`Đã nhập dữ liệu từ ${path.basename(legacyFile)} vào data/music.sqlite.`);
  }

  const genreRepair = sqlite.prepare(`
    SELECT
      (SELECT COUNT(*) FROM genres WHERE name IS NULL OR TRIM(name) = '') AS invalid,
      (SELECT COUNT(DISTINCT songs.genre)
       FROM songs LEFT JOIN genres ON genres.name = songs.genre
       WHERE songs.genre IS NOT NULL AND TRIM(songs.genre) <> '' AND genres.name IS NULL) AS missing
  `).get();
  if (genreRepair.invalid || genreRepair.missing) {
    sqlite.exec('BEGIN TRANSACTION;');
    try {
      sqlite.exec("DELETE FROM genres WHERE name IS NULL OR TRIM(name) = '';");
      sqlite.exec(`
        INSERT OR IGNORE INTO genres (name)
        SELECT DISTINCT genre FROM songs
        WHERE genre IS NOT NULL AND TRIM(genre) <> '';
      `);
      sqlite.exec('COMMIT;');
    } catch (error) {
      sqlite.exec('ROLLBACK;');
      throw error;
    }
    persistSqlite();
    console.log('Đã đồng bộ danh sách thể loại từ các bài hát vào SQLite.');
  }

  db = loadDatabase();
  console.log(`SQLite đã sẵn sàng: ${DB_FILE}`);
}

function saveDb(beforeCommit = null) {
  sqlite.exec('BEGIN TRANSACTION;');
  try {
    sqlite.exec(`
      DELETE FROM playlist_songs;
      DELETE FROM favorites;
      DELETE FROM support_messages;
      DELETE FROM support_conversations;
      DELETE FROM premium_requests;
      DELETE FROM playlists;
      DELETE FROM songs;
      DELETE FROM albums;
      DELETE FROM artists;
      DELETE FROM users;
      DELETE FROM genres;
    `);
    const insertUser = sqlite.prepare(`
      INSERT INTO users (
        id, name, email, password_hash, password_salt, role, status, is_premium, premium_expires_at, session_version
      )
      VALUES (
        @id, @name, @email, @passwordHash, @passwordSalt, @role, @status, @isPremium, @premiumExpiresAt, @sessionVersion
      )
    `);
    const insertArtist = sqlite.prepare('INSERT INTO artists (id, name, bio, avatar) VALUES (@id, @name, @bio, @avatar)');
    const insertAlbum = sqlite.prepare(`
      INSERT INTO albums (id, title, artist_id, year, cover)
      VALUES (@id, @title, @artistId, @year, @cover)
    `);
    const insertSong = sqlite.prepare(`
      INSERT INTO songs (
        id, title, artist_id, album_id, genre, duration, audio_url, cover, plays,
        user_id, lyrics, is_vip, is_trending
      )
      VALUES (
        @id, @title, @artistId, @albumId, @genre, @duration, @audioUrl, @cover, @plays,
        @userId, @lyrics, @isVip, @isTrending
      )
    `);
    const insertPlaylist = sqlite.prepare('INSERT INTO playlists (id, name, user_id) VALUES (@id, @name, @userId)');
    const insertPlaylistSong = sqlite.prepare(`
      INSERT INTO playlist_songs (playlist_id, song_id, position) VALUES (@playlistId, @songId, @position)
    `);
    const insertFavorite = sqlite.prepare('INSERT INTO favorites (user_id, song_id) VALUES (@userId, @songId)');
    const insertPremiumRequest = sqlite.prepare(`
      INSERT INTO premium_requests (
        id, user_id, plan, price, status, created_at, reviewed_at, reviewed_by
      ) VALUES (
        @id, @userId, @plan, @price, @status, @createdAt, @reviewedAt, @reviewedBy
      )
    `);
    const insertSupportConversation = sqlite.prepare(`
      INSERT INTO support_conversations (id, user_id, status, created_at, updated_at, closed_at)
      VALUES (@id, @userId, @status, @createdAt, @updatedAt, @closedAt)
    `);
    const insertSupportMessage = sqlite.prepare(`
      INSERT INTO support_messages (id, conversation_id, sender_id, sender_type, body, created_at)
      VALUES (@id, @conversationId, @senderId, @senderType, @body, @createdAt)
    `);
    const insertGenre = sqlite.prepare('INSERT INTO genres (name) VALUES (?)');

    db.users.forEach((user) => insertUser.run({
      ...user,
      isPremium: hasActivePremium(user) ? 1 : 0,
      premiumExpiresAt: user.premiumExpiresAt || null,
      sessionVersion: user.sessionVersion || 0,
    }));
    db.premiumRequests.forEach((request) => insertPremiumRequest.run({
      ...request,
      reviewedAt: request.reviewedAt || null,
      reviewedBy: request.reviewedBy || null,
    }));
    db.supportConversations = db.supportConversations.filter((conversation) =>
      db.users.some((user) => user.id === conversation.userId)
    );
    db.supportMessages = db.supportMessages.filter((message) =>
      db.supportConversations.some((conversation) => conversation.id === message.conversationId) &&
      db.users.some((user) => user.id === message.senderId)
    );
    db.supportConversations.forEach((conversation) => insertSupportConversation.run({
      ...conversation,
      closedAt: conversation.closedAt || null,
    }));
    db.supportMessages.forEach((message) => insertSupportMessage.run(message));
    db.artists.forEach((artist) => insertArtist.run(artist));
    db.albums.forEach((album) => insertAlbum.run(album));
    db.songs.forEach((song) => insertSong.run({
      ...song,
      albumId: song.albumId ?? null,
      userId: song.userId ?? null,
      lyrics: song.lyrics || '',
      isVip: song.isVip ? 1 : 0,
      isTrending: song.isTrending ? 1 : 0,
    }));
    db.favorites = db.favorites.filter((favorite) =>
      db.users.some((user) => user.id === favorite.userId) &&
      db.songs.some((song) => song.id === favorite.songId)
    );
    db.favorites
      .forEach((favorite) => insertFavorite.run(favorite));
    db.playlists.forEach((playlist) => {
      insertPlaylist.run({ id: playlist.id, name: playlist.name, userId: playlist.userId ?? null });
      playlist.songIds.forEach((songId, position) => {
        insertPlaylistSong.run({ playlistId: playlist.id, songId, position });
      });
    });
    db.genres.forEach((genre) => insertGenre.run([genre]));
    if (beforeCommit) beforeCommit();
    sqlite.exec('COMMIT;');
    persistSqlite();
  } catch (error) {
    sqlite.exec('ROLLBACK;');
    throw error;
  }
}

function expirePendingVnpayRequests(userId) {
  const now = new Date();
  const query = sqlite.prepare(`
    SELECT requests.id
    FROM premium_requests AS requests
    JOIN vnpay_payments AS payments ON payments.premium_request_id = requests.id
    WHERE requests.status = 'pending'
      AND payments.status = 'pending'
      AND payments.expires_at <= ?
      ${userId === undefined ? '' : 'AND requests.user_id = ?'}
  `);
  const params = userId === undefined ? [now.toISOString()] : [now.toISOString(), userId];
  const expiredRequests = query.all(params)
    .map(({ id }) => db.premiumRequests.find((request) => request.id === id))
    .filter(Boolean);
  if (!expiredRequests.length) return 0;

  const previousStates = expiredRequests.map((request) => ({
    request,
    status: request.status,
    reviewedAt: request.reviewedAt,
    reviewedBy: request.reviewedBy,
  }));
  expiredRequests.forEach((request) => {
    request.status = 'rejected';
    request.reviewedAt = now.toISOString();
    request.reviewedBy = null;
  });
  try {
    saveDb();
  } catch (error) {
    previousStates.forEach(({ request, status, reviewedAt, reviewedBy }) => {
      Object.assign(request, { status, reviewedAt, reviewedBy });
    });
    throw error;
  }
  return expiredRequests.length;
}

function effectiveVnpayStatus(payment, now = Date.now()) {
  return payment.status === 'pending' &&
    Number.isFinite(Date.parse(payment.expiresAt)) &&
    Date.parse(payment.expiresAt) <= now
    ? 'expired'
    : payment.status;
}

// Sinh id tăng dần cho một collection
function nextId(list) {
  return list.reduce((max, item) => Math.max(max, item.id), 0) + 1;
}

// Gắn thêm tên nghệ sĩ / album vào bài hát để frontend render dễ hơn
function enrichSong(song) {
  const artist = db.artists.find((a) => a.id === song.artistId);
  const album = db.albums.find((a) => a.id === song.albumId);
  return {
    id: song.id,
    title: song.title,
    artistId: song.artistId,
    artistName: artist ? artist.name : 'Không rõ',
    albumId: song.albumId,
    albumTitle: album ? album.title : null,
    genre: song.genre,
    duration: song.duration,
    cover: song.cover,
    lyrics: song.lyrics || '',
    plays: song.plays || 0,
    isVip: song.isVip === true || song.isVip === 1,
    isTrending: song.isTrending === true || song.isTrending === 1,
    streamUrl: `/api/stream/${song.id}`,
  };
}

function enrichPlaylist(pl, userId = null) {
  const songs = pl.songIds
    .map((id) => db.songs.find((s) => s.id === id))
    .filter(Boolean)
    .map(enrichSong);
  return { id: pl.id, name: pl.name, songs, canEdit: Number.isInteger(userId) && pl.userId === userId };
}

function publicUser(user) {
  const premium = hasActivePremium(user);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone || '',
    role: user.role,
    status: user.status,
    isPremium: premium,
    premiumExpiresAt: premium ? user.premiumExpiresAt || null : null,
  };
}

function isBooleanFlag(value) {
  return value === true || value === 1 || value === 'true' || value === '1';
}

function hasActivePremium(user, now = Date.now()) {
  if (!user || !(user.isPremium === true || user.isPremium === 1)) return false;
  if (!user.premiumExpiresAt) return true;
  const expiresAt = Date.parse(user.premiumExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

function addUtcMonths(date, months) {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function sessionCookie(token, clear = false) {
  const parts = [`${SESSION_COOKIE}=${clear ? '' : token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (clear) parts.push('Max-Age=0');
  if (isProduction) parts.push('Secure');
  return parts.join('; ');
}

function currentUser(req) {
  const token = (req.headers.cookie || '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  if (!token) return null;

  let payload;
  try {
    payload = jwt.verify(token, jwtSecret);
  } catch {
    return null;
  }
  const userId = Number(payload.sub);
  if (!Number.isInteger(userId)) return null;
  const user = db.users.find((candidate) => candidate.id === userId);
  if (!user || (payload.ver || 0) !== (user.sessionVersion || 0)) return null;
  return user && user.status === 'active' ? user : null;
}

function createSession(res, user) {
  const token = jwt.sign(
    { sub: String(user.id), ver: user.sessionVersion || 0 },
    jwtSecret,
    { expiresIn: Math.floor(SESSION_TTL / 1000) }
  );
  res.setHeader('Set-Cookie', sessionCookie(token));
}

function requireAuth(req, res, next) {
  req.user = currentUser(req);
  if (!req.user) return res.status(401).json({ error: 'Vui lòng đăng nhập để tiếp tục' });
  next();
}

function requireAdmin(req, res, next) {
  requireRole('admin')(req, res, next);
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    requireAuth(req, res, () => {
      if (!allowedRoles.includes(req.user.role)) {
        return res.status(403).json({ error: 'Bạn không có quyền sử dụng chức năng này' });
      }
      next();
    });
  };
}

function requireVip(req, res, next) {
  requireAuth(req, res, () => {
    if (!hasActivePremium(req.user)) {
      return res.status(403).json({ error: 'Chức năng này chỉ dành cho tài khoản VIP' });
    }
    next();
  });
}

function passwordResetEmailConfig() {
  const host = process.env.SMTP_HOST;
  const from = process.env.SMTP_FROM;
  const port = Number(process.env.SMTP_PORT || 587);
  if (!host || !from || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if ((user && !pass) || (!user && pass)) return null;
  return {
    host,
    port,
    secure: process.env.SMTP_SECURE === 'true' || port === 465,
    from,
    auth: user ? { user, pass } : undefined,
  };
}

function issuePasswordResetToken(userId) {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TTL).toISOString();
  sqlite.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run([userId]);
  sqlite.prepare(`
    INSERT INTO password_reset_tokens (token_hash, user_id, created_at, expires_at, used_at)
    VALUES (?, ?, ?, ?, NULL)
  `).run([createHash('sha256').update(token).digest('hex'), userId, now.toISOString(), expiresAt]);
  persistSqlite();
  return { token, expiresAt };
}

function emailPasswordResetUrl(token) {
  const baseUrl = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
  return `${baseUrl}/#/auth/reset?token=${encodeURIComponent(token)}`;
}

async function sendPasswordResetEmail(email, token, mailConfig) {
  const { SMTPClient } = await import('emailjs');
  const client = new SMTPClient({
    host: mailConfig.host,
    port: mailConfig.port,
    ssl: mailConfig.secure,
    tls: !mailConfig.secure,
    timeout: 10000,
    ...(mailConfig.auth
      ? { user: mailConfig.auth.user, password: mailConfig.auth.pass }
      : {}),
  });
  try {
    const resetUrl = emailPasswordResetUrl(token);
    await client.sendAsync({
      from: mailConfig.from,
      to: email,
      subject: 'Đặt lại mật khẩu tài khoản Nhạc Online',
      text: `Admin đã duyệt yêu cầu đặt lại mật khẩu của bạn. Mở liên kết sau trong vòng 30 phút: ${resetUrl}\n\nNếu bạn không thực hiện yêu cầu này, hãy bỏ qua email.`,
    });
  } finally {
    client.smtp.close();
  }
}

function passwordResetRequestsForAdmin() {
  return sqlite.prepare(`
    SELECT requests.id, requests.status, requests.created_at AS createdAt,
           requests.reviewed_at AS reviewedAt, users.name AS userName, users.email AS userEmail
    FROM password_reset_requests AS requests
    JOIN users ON users.id = requests.user_id
    ORDER BY CASE requests.status WHEN 'pending' THEN 0 ELSE 1 END, requests.id DESC
  `).all();
}

function visiblePlaylists(userId) {
  return db.playlists.filter((pl) => !Number.isInteger(pl.userId) || pl.userId === userId);
}

/* ------------------------------------------------------------------ */
/* 2. UPLOAD (multer)                                                  */
/* ------------------------------------------------------------------ */

const AUDIO_EXT = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'];
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) =>
      cb(null, file.fieldname === 'audio' ? AUDIO_DIR : COVER_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
    },
  }),
  limits: { fileSize: 30 * 1024 * 1024 }, // tối đa 30MB / file
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = file.fieldname === 'audio' ? AUDIO_EXT : IMAGE_EXT;
    if (!allowed.includes(ext)) {
      return cb(new Error(`Định dạng ${ext || 'không xác định'} không được hỗ trợ`));
    }
    cb(null, true);
  },
});

/* 3. APP + MIDDLEWARE                                                 */
/* ------------------------------------------------------------------ */

const app = express();
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      imgSrc: [
        "'self'",
        'data:',
        'https://images.unsplash.com',
        'https://picsum.photos',
        'https://fastly.picsum.photos',
      ],
    },
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
if (env.CORS_ORIGIN) {
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
}
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public')));
// Chỉ public ảnh bìa; file audio chỉ được truy cập qua /api/stream
app.use('/uploads/covers', express.static(COVER_DIR));

/* ------------------------------------------------------------------ */
/* RATE LIMITING                                                        */
/* ------------------------------------------------------------------ */

const authRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({
    error: 'Bạn đã thử quá nhiều lần. Vui lòng đợi 1 phút rồi thử lại.',
  }),
});

/* ------------------------------------------------------------------ */
/* 4. API: ACCOUNTS                                                    */
/* ------------------------------------------------------------------ */

app.get('/api/auth/me', (req, res) => {
  const user = currentUser(req);
  res.json({ user: user ? publicUser(user) : null });
});

app.post('/api/auth/register', authRateLimit, (req, res) => {
  const body = req.body || {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';

  if (name.length < 2 || name.length > 60) {
    return res.status(400).json({ error: 'Tên phải có từ 2 đến 60 ký tự' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Vui lòng nhập email hợp lệ' });
  }
  if (password.length < 8 || password.length > 128) {
    return res.status(400).json({ error: 'Mật khẩu phải có từ 8 đến 128 ký tự' });
  }
  if (!/^(0|\+84)[0-9]{9,10}$/.test(phone)) {
    return res.status(400).json({ error: 'Vui lòng nhập số điện thoại hợp lệ (ví dụ: 0901234567)' });
  }
  if (db.users.some((user) => user.email === email)) {
    return res.status(409).json({ error: 'Email này đã được đăng ký' });
  }
  if (db.users.some((user) => user.phone === phone)) {
    return res.status(409).json({ error: 'Số điện thoại này đã được đăng ký' });
  }

  const salt = randomBytes(16).toString('hex');
  const user = {
    id: nextId(db.users),
    name,
    email,
    phone,
    passwordHash: scryptSync(password, salt, 64).toString('hex'),
    passwordSalt: salt,
    role: 'user',
    status: 'active',
  };
  db.users.push(user);
  saveDb();
  createSession(res, user);
  res.status(201).json({ user: publicUser(user) });
});

app.post('/api/auth/login', authRateLimit, (req, res) => {
  const body = req.body || {};
  const loginValue = typeof body.login === 'string'
    ? body.login
    : typeof body.email === 'string'
      ? body.email
      : '';
  const login = loginValue.trim();
  const password = typeof body.password === 'string' ? body.password : '';

  if (!login) {
    return res.status(400).json({ error: 'Vui lòng nhập email hoặc số điện thoại' });
  }

  const isEmail = login.includes('@');
  const normalizedLogin = isEmail ? login.toLowerCase() : login;
  const user = db.users.find((candidate) =>
    isEmail ? candidate.email === normalizedLogin : candidate.phone === normalizedLogin
  );

  if (!user || !user.passwordSalt || !user.passwordHash || password.length > 128) {
    return res.status(401).json({ error: 'Email/số điện thoại hoặc mật khẩu không đúng' });
  }
  if (user.status !== 'active') return res.status(403).json({ error: 'Tài khoản đã bị khóa' });
  const expected = Buffer.from(user.passwordHash, 'hex');
  const actual = scryptSync(password, user.passwordSalt, 64);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return res.status(401).json({ error: 'Email hoặc mật khẩu không đúng' });
  }

  createSession(res, user);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
  const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
  if (!currentPassword || currentPassword.length > 128) {
    return res.status(400).json({ error: 'Vui lòng nhập mật khẩu hiện tại' });
  }
  if (newPassword.length < 8 || newPassword.length > 128) {
    return res.status(400).json({ error: 'Mật khẩu mới phải có từ 8 đến 128 ký tự' });
  }

  const expected = Buffer.from(req.user.passwordHash, 'hex');
  const actual = scryptSync(currentPassword, req.user.passwordSalt, 64);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return res.status(400).json({ error: 'Mật khẩu hiện tại không đúng' });
  }
  if (currentPassword === newPassword) {
    return res.status(400).json({ error: 'Mật khẩu mới phải khác mật khẩu hiện tại' });
  }

  const previousCredentials = {
    passwordHash: req.user.passwordHash,
    passwordSalt: req.user.passwordSalt,
    sessionVersion: req.user.sessionVersion || 0,
  };
  const passwordSalt = randomBytes(16).toString('hex');
  req.user.passwordSalt = passwordSalt;
  req.user.passwordHash = scryptSync(newPassword, passwordSalt, 64).toString('hex');
  req.user.sessionVersion = previousCredentials.sessionVersion + 1;
  try {
    saveDb(() => {
      sqlite.prepare(`
        UPDATE password_reset_tokens SET used_at = ?
        WHERE user_id = ? AND used_at IS NULL
      `).run([new Date().toISOString(), req.user.id]);
    });
  } catch (error) {
    req.user.passwordHash = previousCredentials.passwordHash;
    req.user.passwordSalt = previousCredentials.passwordSalt;
    req.user.sessionVersion = previousCredentials.sessionVersion;
    throw error;
  }

  createSession(res, req.user);
  res.json({ message: 'Đổi mật khẩu thành công. Các phiên đăng nhập khác đã được đăng xuất.' });
});

app.put('/api/auth/profile', requireAuth, (req, res) => {
  const body = req.body || {};
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const user = req.user;

  if (!email && !phone) {
    return res.status(400).json({ error: 'Vui lòng nhập ít nhất email hoặc số điện thoại để cập nhật' });
  }

  if (email) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return res.status(400).json({ error: 'Vui lòng nhập email hợp lệ' });
    }
    if (db.users.some((u) => u.id !== user.id && u.email === email)) {
      return res.status(409).json({ error: 'Email này đã được sử dụng bởi tài khoản khác' });
    }
    user.email = email;
  }

  if (phone) {
    if (!/^(0|\+84)[0-9]{9,10}$/.test(phone)) {
      return res.status(400).json({ error: 'Vui lòng nhập số điện thoại hợp lệ (ví dụ: 0901234567)' });
    }
    if (db.users.some((u) => u.id !== user.id && u.phone === phone)) {
      return res.status(409).json({ error: 'Số điện thoại này đã được sử dụng bởi tài khoản khác' });
    }
    user.phone = phone;
  }

  try {
    saveDb(() => {
      sqlite.prepare(
        'UPDATE users SET email = ?, phone = ? WHERE id = ?'
      ).run([user.email, user.phone, user.id]);
    });
  } catch (error) {
    throw error;
  }

  res.json({ message: 'Cập nhật thông tin thành công', user: publicUser(user) });
});

app.get('/api/auth/password-reset-captcha', (req, res) => {
  const now = Date.now();
  for (const [id, challenge] of passwordResetChallenges) {
    if (challenge.expiresAt <= now) passwordResetChallenges.delete(id);
  }
  while (passwordResetChallenges.size >= 500) {
    passwordResetChallenges.delete(passwordResetChallenges.keys().next().value);
  }
  const left = randomBytes(1)[0] % 10 + 1;
  const right = randomBytes(1)[0] % 10 + 1;
  const useAddition = randomBytes(1)[0] % 2 === 0;
  const answer = useAddition ? left + right : Math.abs(left - right);
  const challengeId = randomBytes(18).toString('base64url');
  const expiresAt = now + 5 * 60 * 1000;
  passwordResetChallenges.set(challengeId, {
    answerHash: createHash('sha256').update(String(answer)).digest('hex'),
    expiresAt,
  });
  res.json({
    challengeId,
    question: `${left} ${useAddition ? '+' : '−'} ${right} = ?`,
  });
});

app.post('/api/auth/password-reset-requests', (req, res) => {
  const email = typeof (req.body && req.body.email) === 'string'
    ? req.body.email.trim().toLowerCase()
    : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Vui lòng nhập email hợp lệ' });
  }
  const challengeId = typeof (req.body && req.body.challengeId) === 'string' ? req.body.challengeId : '';
  const challenge = passwordResetChallenges.get(challengeId);
  passwordResetChallenges.delete(challengeId);
  const answer = typeof (req.body && req.body.answer) === 'string' ? req.body.answer.trim() : '';
  const answerHash = createHash('sha256').update(answer).digest();
  const expectedHash = challenge ? Buffer.from(challenge.answerHash, 'hex') : Buffer.alloc(0);
  if (
    !challenge ||
    challenge.expiresAt <= Date.now() ||
    answerHash.length !== expectedHash.length ||
    !timingSafeEqual(answerHash, expectedHash)
  ) {
    return res.status(400).json({ error: 'Mã xác minh không đúng hoặc đã hết hạn. Vui lòng thử lại.' });
  }

  const user = db.users.find((candidate) => candidate.email === email);
  if (user) {
    const pending = sqlite.prepare(`
      SELECT id FROM password_reset_requests WHERE user_id = ? AND status = 'pending'
    `).get([user.id]);
    if (!pending) {
      sqlite.prepare(`
        INSERT INTO password_reset_requests (user_id, status, created_at, reviewed_at, reviewed_by)
        VALUES (?, 'pending', ?, NULL, NULL)
      `).run([user.id, new Date().toISOString()]);
      persistSqlite();
    }
  }
  res.status(202).json({
    message: 'Nếu email khớp tài khoản, yêu cầu sẽ được chuyển cho Admin xem xét. Sau khi duyệt, Admin sẽ gửi link đặt lại mật khẩu riêng cho bạn.',
  });
});

app.post('/api/auth/reset-password', (req, res) => {
  const token = typeof (req.body && req.body.token) === 'string' ? req.body.token : '';
  const password = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';
  if (password.length < 8 || password.length > 128) {
    return res.status(400).json({ error: 'Mật khẩu mới phải có từ 8 đến 128 ký tự' });
  }
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) {
    return res.status(400).json({ error: 'Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn' });
  }
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const resetRecord = sqlite.prepare(`
    SELECT user_id AS userId FROM password_reset_tokens
    WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
  `).get([tokenHash, new Date().toISOString()]);
  const user = resetRecord && db.users.find((candidate) => candidate.id === resetRecord.userId);
  if (!user) {
    return res.status(400).json({ error: 'Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn' });
  }

  const previousCredentials = {
    passwordHash: user.passwordHash,
    passwordSalt: user.passwordSalt,
    sessionVersion: user.sessionVersion || 0,
  };
  const passwordSalt = randomBytes(16).toString('hex');
  user.passwordSalt = passwordSalt;
  user.passwordHash = scryptSync(password, passwordSalt, 64).toString('hex');
  user.sessionVersion = previousCredentials.sessionVersion + 1;
  try {
    saveDb(() => {
      sqlite.prepare(`
        UPDATE password_reset_tokens SET used_at = ?
        WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
      `).run([new Date().toISOString(), tokenHash, new Date().toISOString()]);
      if (sqlite.prepare('SELECT changes() AS changes').get().changes !== 1) {
        throw new Error('Liên kết đặt lại mật khẩu đã được sử dụng hoặc đã hết hạn');
      }
    });
  } catch (error) {
    user.passwordHash = previousCredentials.passwordHash;
    user.passwordSalt = previousCredentials.passwordSalt;
    user.sessionVersion = previousCredentials.sessionVersion;
    if (error.message.startsWith('Liên kết đặt lại mật khẩu')) {
      return res.status(400).json({ error: error.message });
    }
    throw error;
  }
  res.json({ message: 'Đặt lại mật khẩu thành công. Vui lòng đăng nhập bằng mật khẩu mới.' });
});

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', sessionCookie('', true));
  res.json({ ok: true });
});

// Gửi mã xác thực 6 số về email để đặt lại mật khẩu (bỏ qua admin)
app.post('/api/auth/send-reset-code', authRateLimit, (req, res) => {
  const email = typeof (req.body && req.body.email) === 'string'
    ? req.body.email.trim().toLowerCase()
    : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Vui lòng nhập email hợp lệ' });
  }

  const user = db.users.find((candidate) => candidate.email === email);
  // Luôn trả về thành công để không tiết lộ email có tồn tại hay không
  const mailConfig = passwordResetEmailConfig();
  if (!user || !mailConfig) {
    return res.json({ message: 'Nếu email khớp tài khoản, mã xác thực đã được gửi.' });
  }

  // Tạo mã 6 số ngẫu nhiên
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const codeHash = createHash('sha256').update(code).digest('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString(); // 10 phút

  // Xóa mã cũ của user này
  sqlite.prepare('DELETE FROM password_reset_codes WHERE user_id = ?').run([user.id]);
  // Lưu mã mới
  sqlite.prepare(`
    INSERT INTO password_reset_codes (user_id, code_hash, expires_at, used_at, created_at)
    VALUES (?, ?, ?, NULL, ?)
  `).run([user.id, codeHash, expiresAt, now.toISOString()]);
  persistSqlite();

  // Gửi email
  const { SMTPClient } = require('emailjs');
  const client = new SMTPClient({
    host: mailConfig.host,
    port: mailConfig.port,
    ssl: mailConfig.secure,
    tls: !mailConfig.secure,
    timeout: 10000,
    ...(mailConfig.auth ? { user: mailConfig.auth.user, password: mailConfig.auth.pass } : {}),
  });

  client.sendAsync({
    from: mailConfig.from,
    to: email,
    subject: 'Mã xác thực đặt lại mật khẩu - Nhạc Online',
    text: `Mã xác thực của bạn là: ${code}\n\nMã này có hiệu lực trong 10 phút. Nếu bạn không yêu cầu đặt lại mật khẩu, hãy bỏ qua email này.`,
  }).then(() => {
    client.smtp.close();
    res.json({ message: 'Nếu email khớp tài khoản, mã xác thực đã được gửi.' });
  }).catch((error) => {
    client.smtp.close();
    console.error('Không thể gửi mã xác thực:', error);
    res.json({ message: 'Nếu email khớp tài khoản, mã xác thực đã được gửi.' });
  });
});

// Xác minh mã và trả về token đặt lại mật khẩu
app.post('/api/auth/verify-reset-code', authRateLimit, (req, res) => {
  const email = typeof (req.body && req.body.email) === 'string'
    ? req.body.email.trim().toLowerCase()
    : '';
  const code = typeof (req.body && req.body.code) === 'string' ? req.body.code.trim() : '';

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Vui lòng nhập email hợp lệ' });
  }
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'Mã xác thực phải là 6 chữ số' });
  }

  const user = db.users.find((candidate) => candidate.email === email);
  if (!user) {
    return res.status(400).json({ error: 'Mã xác thực không đúng hoặc đã hết hạn' });
  }

  const codeHash = createHash('sha256').update(code).digest('hex');
  const codeRecord = sqlite.prepare(`
    SELECT id FROM password_reset_codes
    WHERE user_id = ? AND code_hash = ? AND used_at IS NULL AND expires_at > ?
  `).get([user.id, codeHash, new Date().toISOString()]);

  if (!codeRecord) {
    return res.status(400).json({ error: 'Mã xác thực không đúng hoặc đã hết hạn' });
  }

  // Đánh dấu mã đã sử dụng
  sqlite.prepare(`
    UPDATE password_reset_codes SET used_at = ? WHERE id = ?
  `).run([new Date().toISOString(), codeRecord.id]);
  persistSqlite();

  // Tạo token đặt lại mật khẩu
  const { token, expiresAt } = issuePasswordResetToken(user.id);

  res.json({ token, expiresAt });
});

app.get('/api/payments/vnpay/config', (req, res) => {
  const config = vnpayConfiguration();
  res.json({
    provider: 'VNPay',
    mode: 'sandbox',
    enabled: config.enabled,
    paymentUrl: VNPAY_SANDBOX_URL,
    message: config.message,
  });
});

app.post('/api/premium/checkout', requireAuth, (req, res) => {
  const config = vnpayConfiguration();
  if (!config.enabled) {
    return res.status(503).json({
      error: config.message || 'VNPay Sandbox chưa được cấu hình.',
    });
  }
  const planKey = req.body && req.body.plan;
  if (!Object.hasOwn(PREMIUM_PLANS, planKey)) {
    return res.status(400).json({ error: 'Gói VIP không hợp lệ. Chọn gói 1, 6 hoặc 12 tháng.' });
  }
  expirePendingVnpayRequests(req.user.id);
  if (db.premiumRequests.some((request) => request.userId === req.user.id && request.status === 'pending')) {
    return res.status(409).json({ error: 'Bạn đã có giao dịch VIP đang chờ xử lý.' });
  }

  const plan = PREMIUM_PLANS[planKey];
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
  const request = {
    id: nextId(db.premiumRequests),
    userId: req.user.id,
    plan: planKey,
    price: plan.price,
    status: 'pending',
    createdAt: now.toISOString(),
    reviewedAt: null,
    reviewedBy: null,
  };
  const txnRef = `${Date.now()}${randomBytes(8).toString('hex')}`;
  const orderInfo = `VIP ${planKey} request ${request.id}`;
  const clientIp = requestClientIp(req);
  const paymentParams = {
    vnp_Version: '2.1.0',
    vnp_Command: 'pay',
    vnp_TmnCode: env.VNPAY_TMN_CODE,
    vnp_Amount: String(plan.price * 100),
    vnp_CurrCode: 'VND',
    vnp_BankCode: 'NCB',
    vnp_TxnRef: txnRef,
    vnp_OrderInfo: orderInfo,
    vnp_OrderType: 'other',
    vnp_Locale: 'vn',
    vnp_ReturnUrl: config.returnUrl,
    vnp_IpAddr: clientIp,
    vnp_CreateDate: vnpayDate(now),
    vnp_ExpireDate: vnpayDate(expiresAt),
  };
  const signedParams = vnpayCanonicalQuery(paymentParams);
  const paymentUrl = `${VNPAY_SANDBOX_URL}?${signedParams}&vnp_SecureHash=${signVnpayParams(paymentParams, env.VNPAY_HASH_SECRET)}`;
  const paymentId = sqlite.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM vnpay_payments').get().id;

  db.premiumRequests.push(request);
  try {
    saveDb(() => {
      sqlite.prepare(`
        INSERT INTO vnpay_payments (
          id, premium_request_id, user_id, txn_ref, plan, amount, currency, status,
          order_info, client_ip, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'VND', 'pending', ?, ?, ?, ?)
      `).run([
        paymentId,
        request.id,
        req.user.id,
        txnRef,
        planKey,
        plan.price,
        orderInfo,
        clientIp,
        now.toISOString(),
        expiresAt.toISOString(),
      ]);
    });
  } catch (error) {
    db.premiumRequests.pop();
    throw error;
  }

  console.info(`[VNPay Sandbox] Created order ${txnRef} for user ${req.user.id}: ${plan.price} VND.`);
  res.status(201).json({
    paymentUrl,
    txnRef,
    plan: planKey,
    amount: plan.price,
    currency: 'VND',
    status: 'pending',
    expiresAt: expiresAt.toISOString(),
  });
});

function recordVerifiedVnpayPaymentResult(params) {
  const payment = sqlite.prepare(`
    SELECT id, premium_request_id AS premiumRequestId, user_id AS userId, plan, amount, status
    FROM vnpay_payments WHERE txn_ref = ?
  `).get([params.vnp_TxnRef]);
  if (!payment) return { RspCode: '01', Message: 'Order not found' };
  if (Number(params.vnp_Amount) !== payment.amount * 100) {
    return { RspCode: '04', Message: 'Invalid amount' };
  }
  if (payment.status !== 'pending') {
    return { RspCode: '02', Message: 'Order already confirmed' };
  }

  const request = db.premiumRequests.find((item) => item.id === payment.premiumRequestId);
  if (!request || request.userId !== payment.userId || request.plan !== payment.plan || request.price !== payment.amount) {
    return { RspCode: '01', Message: 'Order not found' };
  }

  const paid = params.vnp_ResponseCode === '00' && params.vnp_TransactionStatus === '00';
  const now = new Date().toISOString();
  const user = db.users.find((item) => item.id === payment.userId);
  const previousRequest = { status: request.status, reviewedAt: request.reviewedAt, reviewedBy: request.reviewedBy };
  const previousPremium = user
    ? { isPremium: user.isPremium, premiumExpiresAt: user.premiumExpiresAt }
    : null;
  const nextStatus = paid ? 'paid' : 'failed';
  const canActivateVip = request.status === 'pending' ||
    (request.status === 'rejected' && request.reviewedBy === null);
  const activateVip = paid && canActivateVip;

  if (!paid && request.status === 'pending') {
    request.status = 'rejected';
    request.reviewedAt = now;
    request.reviewedBy = null;
  } else if (activateVip) {
    if (!user) return { RspCode: '01', Message: 'Order not found' };
    request.status = 'approved';
    request.reviewedAt = now;
    request.reviewedBy = null;
    const currentExpiry = user.premiumExpiresAt ? Date.parse(user.premiumExpiresAt) : 0;
    const startsAt = hasActivePremium(user) && Number.isFinite(currentExpiry) && currentExpiry > Date.now()
      ? new Date(currentExpiry)
      : new Date();
    user.isPremium = 1;
    user.premiumExpiresAt = addUtcMonths(startsAt, PREMIUM_PLANS[request.plan].months).toISOString();
  }

  try {
    saveDb(() => {
      sqlite.prepare(`
        UPDATE vnpay_payments
        SET status = ?, response_code = ?, transaction_status = ?, transaction_no = ?,
            bank_code = ?, bank_tran_no = ?, card_type = ?, pay_date = ?, callback_at = ?,
            vip_activated = ?
        WHERE id = ? AND status = 'pending'
      `).run([
        nextStatus,
        params.vnp_ResponseCode || null,
        params.vnp_TransactionStatus || null,
        params.vnp_TransactionNo || null,
        params.vnp_BankCode || null,
        params.vnp_BankTranNo || null,
        params.vnp_CardType || null,
        params.vnp_PayDate || null,
        now,
        activateVip ? 1 : 0,
        payment.id,
      ]);
    });
  } catch (error) {
    Object.assign(request, previousRequest);
    if (user && previousPremium) Object.assign(user, previousPremium);
    throw error;
  }

  console.info(
    `[VNPay Sandbox] Reconciled order ${params.vnp_TxnRef}: response=${params.vnp_ResponseCode}, ` +
    `transaction=${params.vnp_TransactionStatus}, vipActivated=${activateVip}.`
  );
  return { RspCode: '00', Message: 'Confirm Success' };
}

app.get('/api/premium/payments/:txnRef', requireAuth, (req, res) => {
  expirePendingVnpayRequests(req.user.id);
  const payment = sqlite.prepare(`
    SELECT txn_ref AS txnRef, plan, amount, currency, status, order_info AS orderInfo,
           created_at AS createdAt, expires_at AS expiresAt, response_code AS responseCode,
           transaction_status AS transactionStatus, transaction_no AS transactionNo,
           bank_code AS bankCode, bank_tran_no AS bankTranNo, card_type AS cardType,
           pay_date AS payDate, callback_at AS callbackAt, vip_activated AS vipActivated
    FROM vnpay_payments WHERE txn_ref = ? AND user_id = ?
  `).get([req.params.txnRef, req.user.id]);
  if (!payment) return res.status(404).json({ error: 'Không tìm thấy giao dịch của tài khoản này.' });
  res.json({ ...payment, status: effectiveVnpayStatus(payment) });
});

app.get('/api/payments/vnpay/ipn', (req, res) => {
  const config = vnpayConfiguration();
  if (!config.enabled) return res.status(503).json({ RspCode: '99', Message: 'Payment gateway unavailable' });
  const params = vnpayParamsFromQuery(req.query);
  if (!hasValidVnpaySignature(params, env.VNPAY_HASH_SECRET) ||
      params.vnp_TmnCode !== env.VNPAY_TMN_CODE) {
    return res.json({ RspCode: '97', Message: 'Invalid signature' });
  }

  res.json(recordVerifiedVnpayPaymentResult(params));
});

app.post('/api/premium/payments/:txnRef/check', requireAuth, async (req, res) => {
  const config = vnpayConfiguration();
  if (!config.enabled) return res.status(503).json({ error: 'VNPay Sandbox chưa được cấu hình.' });

  expirePendingVnpayRequests(req.user.id);
  const payment = sqlite.prepare(`
    SELECT txn_ref AS txnRef, plan, amount, currency, status, order_info AS orderInfo,
           created_at AS createdAt, expires_at AS expiresAt, response_code AS responseCode,
           transaction_status AS transactionStatus, transaction_no AS transactionNo,
           bank_code AS bankCode, bank_tran_no AS bankTranNo, card_type AS cardType,
           pay_date AS payDate, callback_at AS callbackAt, vip_activated AS vipActivated
    FROM vnpay_payments WHERE txn_ref = ? AND user_id = ?
  `).get([req.params.txnRef, req.user.id]);
  if (!payment) return res.status(404).json({ error: 'Không tìm thấy giao dịch của tài khoản này.' });
  if (payment.status !== 'pending') {
    return res.json({ ...payment, status: effectiveVnpayStatus(payment) });
  }

  const requestData = {
    vnp_RequestId: `${Date.now()}${randomBytes(8).toString('hex')}`,
    vnp_Version: '2.1.0',
    vnp_Command: 'querydr',
    vnp_TmnCode: env.VNPAY_TMN_CODE,
    vnp_TxnRef: payment.txnRef,
    vnp_TransactionDate: vnpayDate(new Date(payment.createdAt)),
    vnp_CreateDate: vnpayDate(new Date()),
    vnp_IpAddr: requestClientIp(req),
    vnp_OrderInfo: payment.orderInfo,
  };
  requestData.vnp_SecureHash = vnpayQueryRequestSignature(requestData, env.VNPAY_HASH_SECRET);

  let queryResult;
  try {
    const response = await fetch(vnpayQueryUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestData),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`VNPay query returned HTTP ${response.status}`);
    queryResult = await response.json();
  } catch (error) {
    console.error(`[VNPay Sandbox] Query failed for ${payment.txnRef}: ${error.message}`);
    return res.status(502).json({ error: 'Không thể truy vấn VNPay lúc này. Hãy thử lại sau.' });
  }

  const signatureValid = hasValidVnpayQueryResponse(
    queryResult,
    env.VNPAY_HASH_SECRET,
    env.VNPAY_TMN_CODE
  );
  const commandMatches = queryResult?.vnp_Command === 'querydr';
  const merchantMatches = queryResult?.vnp_TmnCode === env.VNPAY_TMN_CODE;
  const transactionMatches = queryResult?.vnp_TxnRef === payment.txnRef;
  if (!signatureValid || !commandMatches || !merchantMatches || !transactionMatches) {
    console.error(
      `[VNPay Sandbox] Query response validation failed for ${payment.txnRef}: ` +
      `signatureValid=${signatureValid}, commandMatches=${commandMatches}, ` +
      `merchantMatches=${merchantMatches}, transactionMatches=${transactionMatches}, ` +
      `responseCode=${queryResult?.vnp_ResponseCode ?? 'missing'}.`
    );
    return res.status(502).json({ error: 'Không xác thực được phản hồi truy vấn từ VNPay.' });
  }
  if (queryResult.vnp_ResponseCode !== '00') {
    if (queryResult.vnp_ResponseCode === '91') {
      return res.status(502).json({
        error: 'VNPay chưa tìm thấy giao dịch này. Đơn vẫn đang chờ; không thanh toán lại.',
      });
    }
    return res.status(502).json({ error: 'VNPay chưa xác nhận được giao dịch. Hãy thử lại sau.' });
  }
  if (Number(queryResult.vnp_Amount) !== payment.amount * 100) {
    console.error(`[VNPay Sandbox] Query response amount mismatch for ${payment.txnRef}.`);
    return res.status(502).json({ error: 'Số tiền giao dịch VNPay không khớp với đơn hàng.' });
  }
  if (queryResult.vnp_TransactionStatus === '00') {
    const result = recordVerifiedVnpayPaymentResult({
      vnp_TmnCode: env.VNPAY_TMN_CODE,
      vnp_TxnRef: queryResult.vnp_TxnRef,
      vnp_Amount: queryResult.vnp_Amount,
      vnp_ResponseCode: '00',
      vnp_TransactionStatus: queryResult.vnp_TransactionStatus,
      vnp_TransactionNo: queryResult.vnp_TransactionNo,
      vnp_BankCode: queryResult.vnp_BankCode,
      vnp_PayDate: queryResult.vnp_PayDate,
    });
    if (result.RspCode !== '00' && result.RspCode !== '02') {
      return res.status(409).json({ error: 'Không thể cập nhật giao dịch đã xác minh.' });
    }
  }

  const updatedPayment = sqlite.prepare(`
    SELECT txn_ref AS txnRef, plan, amount, currency, status, order_info AS orderInfo,
           created_at AS createdAt, expires_at AS expiresAt, response_code AS responseCode,
           transaction_status AS transactionStatus, transaction_no AS transactionNo,
           bank_code AS bankCode, bank_tran_no AS bankTranNo, card_type AS cardType,
           pay_date AS payDate, callback_at AS callbackAt, vip_activated AS vipActivated
    FROM vnpay_payments WHERE txn_ref = ? AND user_id = ?
  `).get([req.params.txnRef, req.user.id]);
  res.json({ ...updatedPayment, status: effectiveVnpayStatus(updatedPayment) });
});

app.get('/api/payments/vnpay/return', (req, res) => {
  const config = vnpayConfiguration();
  const params = vnpayParamsFromQuery(req.query);
  if (!config.enabled ||
      !hasValidVnpaySignature(params, env.VNPAY_HASH_SECRET) ||
      params.vnp_TmnCode !== env.VNPAY_TMN_CODE) {
    return res.status(400).type('text').send('VNPay return signature is invalid.');
  }
  const payment = sqlite.prepare('SELECT amount FROM vnpay_payments WHERE txn_ref = ?')
    .get([params.vnp_TxnRef]);
  if (!payment || Number(params.vnp_Amount) !== payment.amount * 100) {
    return res.status(400).type('text').send('VNPay return does not match a known order.');
  }

  const appBaseUrl = (env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
  res.redirect(303, `${appBaseUrl}/#/premium/payment/${encodeURIComponent(params.vnp_TxnRef)}`);
});

app.get('/api/premium/requests', requireAuth, (req, res) => {
  expirePendingVnpayRequests(req.user.id);
  res.json(db.premiumRequests
    .filter((request) => request.userId === req.user.id)
    .slice()
    .sort((a, b) => b.id - a.id)
    .map((request) => {
      const payment = sqlite.prepare(`
        SELECT txn_ref AS txnRef, status, amount, currency, response_code AS responseCode,
               transaction_no AS transactionNo, created_at AS createdAt, expires_at AS expiresAt,
               callback_at AS callbackAt
        FROM vnpay_payments WHERE premium_request_id = ?
        ORDER BY id DESC LIMIT 1
      `).get([request.id]);
      return {
        ...request,
        payment: payment ? { ...payment, status: effectiveVnpayStatus(payment) } : null,
      };
    }));
});

app.post(['/api/premium/requests', '/api/premium/upgrade'], requireAuth, (req, res) => {
  if (vnpayConfiguration().enabled) {
    return res.status(409).json({ error: 'Hãy tạo giao dịch VNPay từ trang Gói VIP.' });
  }
  const planKey = req.body && req.body.plan;
  if (!Object.hasOwn(PREMIUM_PLANS, planKey)) {
    return res.status(400).json({ error: 'Gói VIP không hợp lệ. Chọn gói 1, 6 hoặc 12 tháng.' });
  }
  expirePendingVnpayRequests(req.user.id);
  if (db.premiumRequests.some((request) => request.userId === req.user.id && request.status === 'pending')) {
    return res.status(409).json({ error: 'Bạn đã có yêu cầu nâng cấp đang chờ Admin duyệt.' });
  }
  const plan = PREMIUM_PLANS[planKey];
  const request = {
    id: nextId(db.premiumRequests),
    userId: req.user.id,
    plan: planKey,
    price: plan.price,
    status: 'pending',
    createdAt: new Date().toISOString(),
    reviewedAt: null,
    reviewedBy: null,
  };
  db.premiumRequests.push(request);
  saveDb();
  res.status(201).json(request);
});

app.get('/api/admin/premium-requests', requireAdmin, (req, res) => {
  expirePendingVnpayRequests();
  res.json(db.premiumRequests.slice().sort((a, b) => b.id - a.id).map((request) => {
    const user = db.users.find((candidate) => candidate.id === request.userId);
    const payment = sqlite.prepare(`
      SELECT txn_ref AS txnRef, status, response_code AS responseCode,
             transaction_no AS transactionNo, expires_at AS expiresAt, callback_at AS callbackAt
      FROM vnpay_payments WHERE premium_request_id = ?
      ORDER BY id DESC LIMIT 1
    `).get([request.id]);
    return {
      ...request,
      userName: user ? user.name : 'Tài khoản đã xóa',
      userEmail: user ? user.email : '',
      payment: payment ? { ...payment, status: effectiveVnpayStatus(payment) } : null,
    };
  }));
});

app.post('/api/admin/premium-requests/:id/review', requireAdmin, (req, res) => {
  expirePendingVnpayRequests();
  const request = db.premiumRequests.find((candidate) => candidate.id === Number(req.params.id));
  if (!request) return res.status(404).json({ error: 'Không tìm thấy yêu cầu nâng cấp' });
  if (request.status !== 'pending') return res.status(409).json({ error: 'Yêu cầu này đã được xử lý' });
  const activePayment = sqlite.prepare(`
    SELECT id FROM vnpay_payments
    WHERE premium_request_id = ? AND status = 'pending'
  `).get([request.id]);
  if (activePayment) {
    return res.status(409).json({ error: 'Yêu cầu này đang thanh toán qua VNPay; hãy chờ IPN xác nhận.' });
  }
  const action = req.body && req.body.action;
  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'Thao tác duyệt không hợp lệ' });
  }
  request.status = action === 'approve' ? 'approved' : 'rejected';
  request.reviewedAt = new Date().toISOString();
  request.reviewedBy = req.user.id;
  if (action === 'approve') {
    const user = db.users.find((candidate) => candidate.id === request.userId);
    if (!user) return res.status(404).json({ error: 'Không tìm thấy tài khoản của yêu cầu' });
    const currentExpiry = user.premiumExpiresAt ? Date.parse(user.premiumExpiresAt) : 0;
    const startsAt = hasActivePremium(user) && Number.isFinite(currentExpiry) && currentExpiry > Date.now()
      ? new Date(currentExpiry)
      : new Date();
    user.isPremium = 1;
    user.premiumExpiresAt = addUtcMonths(startsAt, PREMIUM_PLANS[request.plan].months).toISOString();
  }
  saveDb();
  res.json({ ...request });
});

app.post('/api/admin/users/:id/premium', requireAdmin, (req, res) => {
  const user = db.users.find((candidate) => candidate.id === Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
  const action = req.body && req.body.action;
  if (!['grant', 'revoke'].includes(action)) {
    return res.status(400).json({ error: 'Thao tác VIP không hợp lệ' });
  }
  if (action === 'grant') {
    const currentExpiry = user.premiumExpiresAt ? Date.parse(user.premiumExpiresAt) : 0;
    const startsAt = hasActivePremium(user) && Number.isFinite(currentExpiry) && currentExpiry > Date.now()
      ? new Date(currentExpiry)
      : new Date();
    user.isPremium = 1;
    user.premiumExpiresAt = addUtcMonths(startsAt, 1).toISOString();
  } else {
    user.isPremium = 0;
    user.premiumExpiresAt = null;
  }
  saveDb();
  res.json(publicUser(user));
});

function supportMessagesFor(conversationId, afterId) {
  const messages = db.supportMessages.filter((message) =>
    message.conversationId === conversationId && (afterId === null || message.id > afterId)
  );
  return afterId === null ? messages.slice(-100) : messages.slice(0, 100);
}

function supportConversationForUser(conversation, user) {
  return {
    id: conversation.id,
    status: conversation.status,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    closedAt: conversation.closedAt,
    userName: user.name,
  };
}

function parseSupportAfterId(value) {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value)) return NaN;
  const afterId = Number(value);
  return Number.isSafeInteger(afterId) ? afterId : NaN;
}

function supportMessageBody(body) {
  const message = body && typeof body.message === 'string' ? body.message.trim() : '';
  return message.length > 0 && message.length <= 2000 ? message : null;
}

app.get('/api/support/conversations/current', requireAuth, (req, res) => {
  const conversation = db.supportConversations
    .filter((item) => item.userId === req.user.id)
    .sort((a, b) => b.id - a.id)[0];
  if (!conversation) return res.json({ conversation: null, messages: [] });
  const afterId = parseSupportAfterId(req.query.after);
  if (Number.isNaN(afterId)) return res.status(400).json({ error: 'Mã tin nhắn không hợp lệ' });
  res.json({
    conversation: supportConversationForUser(conversation, req.user),
    messages: supportMessagesFor(conversation.id, afterId),
  });
});

app.post('/api/support/conversations', requireAuth, (req, res) => {
  const existing = db.supportConversations.find((conversation) =>
    conversation.userId === req.user.id && conversation.status !== 'closed'
  );
  if (existing) {
    return res.json({
      conversation: supportConversationForUser(existing, req.user),
      messages: supportMessagesFor(existing.id, null),
    });
  }
  const now = new Date().toISOString();
  const conversation = {
    id: nextId(db.supportConversations),
    userId: req.user.id,
    status: 'waiting',
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  db.supportConversations.push(conversation);
  saveDb();
  res.status(201).json({
    conversation: supportConversationForUser(conversation, req.user),
    messages: [],
  });
});

app.get('/api/support/conversations/:id/messages', requireAuth, (req, res) => {
  const conversation = db.supportConversations.find((item) =>
    item.id === Number(req.params.id) && item.userId === req.user.id
  );
  if (!conversation) return res.status(404).json({ error: 'Không tìm thấy cuộc trò chuyện' });
  const afterId = parseSupportAfterId(req.query.after);
  if (Number.isNaN(afterId)) return res.status(400).json({ error: 'Mã tin nhắn không hợp lệ' });
  res.json({
    conversation: supportConversationForUser(conversation, req.user),
    messages: supportMessagesFor(conversation.id, afterId),
  });
});

app.post('/api/support/conversations/:id/messages', requireAuth, (req, res) => {
  const conversation = db.supportConversations.find((item) =>
    item.id === Number(req.params.id) && item.userId === req.user.id
  );
  if (!conversation) return res.status(404).json({ error: 'Không tìm thấy cuộc trò chuyện' });
  if (conversation.status === 'closed') return res.status(409).json({ error: 'Cuộc trò chuyện đã kết thúc. Hãy kết nối chuyên viên lại.' });
  const body = supportMessageBody(req.body);
  if (!body) return res.status(400).json({ error: 'Tin nhắn phải có từ 1 đến 2000 ký tự' });
  const message = {
    id: nextId(db.supportMessages),
    conversationId: conversation.id,
    senderId: req.user.id,
    senderType: 'user',
    body,
    createdAt: new Date().toISOString(),
  };
  conversation.updatedAt = message.createdAt;
  db.supportMessages.push(message);
  saveDb();
  res.status(201).json(message);
});

app.get('/api/admin/support/conversations', requireAdmin, (req, res) => {
  const conversations = db.supportConversations
    .filter((conversation) => conversation.status !== 'closed')
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((conversation) => {
      const user = db.users.find((candidate) => candidate.id === conversation.userId);
      const lastMessage = db.supportMessages
        .filter((message) => message.conversationId === conversation.id)
        .at(-1);
      return {
        ...conversation,
        userName: user ? user.name : 'Tài khoản đã xóa',
        userEmail: user ? user.email : '',
        lastMessage: lastMessage ? lastMessage.body : '',
      };
    });
  res.json(conversations);
});

app.get('/api/admin/support/conversations/:id/messages', requireAdmin, (req, res) => {
  const conversation = db.supportConversations.find((item) => item.id === Number(req.params.id));
  if (!conversation) return res.status(404).json({ error: 'Không tìm thấy cuộc trò chuyện' });
  const user = db.users.find((candidate) => candidate.id === conversation.userId);
  const afterId = parseSupportAfterId(req.query.after);
  if (Number.isNaN(afterId)) return res.status(400).json({ error: 'Mã tin nhắn không hợp lệ' });
  res.json({
    conversation: {
      ...conversation,
      userName: user ? user.name : 'Tài khoản đã xóa',
      userEmail: user ? user.email : '',
    },
    messages: supportMessagesFor(conversation.id, afterId),
  });
});

app.post('/api/admin/support/conversations/:id/messages', requireAdmin, (req, res) => {
  const conversation = db.supportConversations.find((item) => item.id === Number(req.params.id));
  if (!conversation) return res.status(404).json({ error: 'Không tìm thấy cuộc trò chuyện' });
  if (conversation.status === 'closed') return res.status(409).json({ error: 'Cuộc trò chuyện đã kết thúc' });
  const body = supportMessageBody(req.body);
  if (!body) return res.status(400).json({ error: 'Tin nhắn phải có từ 1 đến 2000 ký tự' });
  const message = {
    id: nextId(db.supportMessages),
    conversationId: conversation.id,
    senderId: req.user.id,
    senderType: 'admin',
    body,
    createdAt: new Date().toISOString(),
  };
  conversation.status = 'active';
  conversation.updatedAt = message.createdAt;
  db.supportMessages.push(message);
  saveDb();
  res.status(201).json(message);
});

app.post('/api/admin/support/conversations/:id/close', requireAdmin, (req, res) => {
  const conversation = db.supportConversations.find((item) => item.id === Number(req.params.id));
  if (!conversation) return res.status(404).json({ error: 'Không tìm thấy cuộc trò chuyện' });
  if (conversation.status === 'closed') return res.status(409).json({ error: 'Cuộc trò chuyện đã kết thúc' });
  conversation.status = 'closed';
  conversation.closedAt = new Date().toISOString();
  conversation.updatedAt = conversation.closedAt;
  saveDb();
  res.json(supportConversationForUser(
    conversation,
    db.users.find((user) => user.id === conversation.userId) || { name: 'Tài khoản đã xóa' }
  ));
});

/* ------------------------------------------------------------------ */
/* 5. API: ADMIN                                                      */
/* ------------------------------------------------------------------ */

app.get('/api/admin/overview', requireAdmin, (req, res) => {
  expirePendingVnpayRequests();
  const songsByGenre = new Map();
  db.songs.forEach((song) => songsByGenre.set(song.genre || 'Khác', (songsByGenre.get(song.genre || 'Khác') || 0) + 1));
  res.json({
    songCount: db.songs.length,
    userCount: db.users.length,
    activeUserCount: db.users.filter((user) => user.status === 'active').length,
    blockedUserCount: db.users.filter((user) => user.status === 'blocked').length,
    premiumUserCount: db.users.filter(hasActivePremium).length,
    albumCount: db.albums.length,
    genreCount: db.genres.length,
    vipSongCount: db.songs.filter((song) => song.isVip === true || song.isVip === 1).length,
    pendingPremiumCount: db.premiumRequests.filter((request) => request.status === 'pending').length,
    openSupportCount: db.supportConversations.filter((conversation) => conversation.status !== 'closed').length,
    genreStats: [...songsByGenre.entries()]
      .map(([genre, songCount]) => ({ genre, songCount }))
      .sort((a, b) => b.songCount - a.songCount || a.genre.localeCompare(b.genre, 'vi')),
    topSongs: db.songs
      .slice()
      .sort((a, b) => (b.plays || 0) - (a.plays || 0))
      .slice(0, 5)
      .map(enrichSong),
    trendingSongs: db.songs
      .filter((song) => song.isTrending === true || song.isTrending === 1)
      .sort((a, b) => (b.plays || 0) - (a.plays || 0))
      .map(enrichSong),
  });
});

app.get('/api/admin/listening-analytics', requireAdmin, (req, res) => {
  const periods = {
    day: { label: '24 giờ qua', buckets: 24, unit: 'hour', durationMs: 24 * 60 * 60 * 1000 },
    week: { label: '7 ngày qua', buckets: 7, unit: 'day', durationMs: 7 * 24 * 60 * 60 * 1000 },
    month: { label: '30 ngày qua', buckets: 30, unit: 'day', durationMs: 30 * 24 * 60 * 60 * 1000 },
    all: { label: 'Toàn bộ lịch sử', buckets: 12, unit: 'month', durationMs: null },
  };
  const periodKey = typeof req.query.period === 'string' ? req.query.period : 'week';
  const period = Object.hasOwn(periods, periodKey) ? periods[periodKey] : null;
  if (!period) {
    return res.status(400).json({ error: 'Khoảng thời gian không hợp lệ. Chọn day, week, month hoặc all.' });
  }

  const now = new Date();
  const since = period.durationMs === null ? null : new Date(now.getTime() - period.durationMs).toISOString();
  const whereSql = since ? 'WHERE played_at >= ?' : '';
  const queryParams = since ? [since] : [];
  const summary = sqlite.prepare(`
    SELECT COUNT(*) AS listenCount, COUNT(DISTINCT user_id) AS uniqueListeners
    FROM listening_history ${whereSql}
  `).get(queryParams);
  const bucketExpression = period.unit === 'hour'
    ? 'substr(played_at, 1, 13)'
    : period.unit === 'month'
      ? 'substr(played_at, 1, 7)'
      : 'substr(played_at, 1, 10)';
  const bucketCounts = sqlite.prepare(`
    SELECT ${bucketExpression} AS bucket, COUNT(*) AS listenCount
    FROM listening_history ${whereSql}
    GROUP BY bucket
  `).all(queryParams);
  const start = new Date(now);
  if (period.unit === 'hour') {
    start.setUTCMinutes(0, 0, 0);
    start.setUTCHours(start.getUTCHours() - period.buckets + 1);
  } else if (period.unit === 'day') {
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - period.buckets + 1);
  } else {
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCMonth(start.getUTCMonth() - period.buckets + 1);
  }
  const countByBucket = new Map(bucketCounts.map((item) => [item.bucket, item.listenCount]));
  const chart = Array.from({ length: period.buckets }, (_, index) => {
    const bucket = new Date(start);
    if (period.unit === 'hour') bucket.setUTCHours(bucket.getUTCHours() + index);
    else if (period.unit === 'day') bucket.setUTCDate(bucket.getUTCDate() + index);
    else bucket.setUTCMonth(bucket.getUTCMonth() + index);
    const iso = bucket.toISOString();
    const key = period.unit === 'hour' ? iso.slice(0, 13) : period.unit === 'month' ? iso.slice(0, 7) : iso.slice(0, 10);
    return { key, listenCount: countByBucket.get(key) || 0 };
  });
  const topSongs = sqlite.prepare(`
    SELECT song_id AS songId, song_title AS title, artist_name AS artistName, COUNT(*) AS listenCount
    FROM listening_history ${whereSql}
    GROUP BY song_id, song_title, artist_name
    ORDER BY listenCount DESC, title COLLATE NOCASE
    LIMIT 10
  `).all(queryParams);
  const recent = sqlite.prepare(`
    SELECT id, user_id AS userId, user_name AS userName, user_email AS userEmail,
           song_id AS songId, song_title AS songTitle, artist_name AS artistName,
           played_at AS playedAt
    FROM listening_history ${whereSql}
    ORDER BY id DESC
    LIMIT 50
  `).all(queryParams);

  res.json({
    generatedAt: now.toISOString(),
    period: periodKey,
    periodLabel: period.label,
    retention: 'indefinite',
    summary,
    chart,
    topSongs,
    recent,
  });
});

app.get('/api/admin/revenue', requireAdmin, (req, res) => {
  const now = new Date();
  const nowMs = now.getTime();
  const periods = [
    { key: 'day', label: '24 giờ qua', durationMs: 24 * 60 * 60 * 1000 },
    { key: 'week', label: '7 ngày qua', durationMs: 7 * 24 * 60 * 60 * 1000 },
    { key: 'month', label: '30 ngày qua', durationMs: 30 * 24 * 60 * 60 * 1000 },
    { key: 'halfYear', label: '6 tháng qua', durationMs: 183 * 24 * 60 * 60 * 1000 },
    { key: 'year', label: '12 tháng qua', durationMs: 365 * 24 * 60 * 60 * 1000 },
  ];
  const approvedSales = db.premiumRequests
    .filter((request) => request.status === 'approved' && Number.isFinite(Date.parse(request.reviewedAt)))
    .map((request) => {
      const user = db.users.find((candidate) => candidate.id === request.userId);
      return {
        requestId: request.id,
        userName: user ? user.name : 'Tài khoản đã xóa',
        userEmail: user ? user.email : '',
        plan: request.plan,
        amount: Number.isSafeInteger(request.price) && request.price >= 0 ? request.price : 0,
        reviewedAt: request.reviewedAt,
      };
    });
  const historicalSales = approvedSales.filter((sale) => Date.parse(sale.reviewedAt) <= nowMs);
  const totals = Object.fromEntries([
    ['all', historicalSales.reduce((sum, sale) => sum + sale.amount, 0)],
    ...periods.map((period) => [
      period.key,
      historicalSales
        .filter((sale) => Date.parse(sale.reviewedAt) >= nowMs - period.durationMs)
        .reduce((sum, sale) => sum + sale.amount, 0),
    ]),
  ]);
  const createChart = (start, end, bucketCount, granularity) => Array.from({ length: bucketCount }, (_, index) => {
    const bucketStart = start + (end - start) * index / bucketCount;
    const bucketEnd = start + (end - start) * (index + 1) / bucketCount;
    return {
      date: new Date(bucketStart).toISOString(),
      amount: historicalSales
        .filter((sale) => {
          const reviewedAt = Date.parse(sale.reviewedAt);
          return reviewedAt >= bucketStart &&
            (index === bucketCount - 1 ? reviewedAt <= bucketEnd : reviewedAt < bucketEnd);
        })
        .reduce((sum, sale) => sum + sale.amount, 0),
      granularity,
    };
  });
  const charts = Object.fromEntries(periods.map((period) => {
    const bucketCount = period.key === 'day' ? 24
      : period.key === 'week' ? 7
        : period.key === 'month' ? 30
          : period.key === 'halfYear' ? 26 : 52;
    return [period.key, createChart(
      nowMs - period.durationMs,
      nowMs,
      bucketCount,
      period.key === 'day' ? 'hour' : period.key === 'month' || period.key === 'week' ? 'day' : 'week'
    )];
  }));
  const firstSaleAt = historicalSales.reduce(
    (first, sale) => Math.min(first, Date.parse(sale.reviewedAt)),
    nowMs
  );
  const allChartStart = Date.UTC(
    new Date(firstSaleAt).getUTCFullYear(),
    new Date(firstSaleAt).getUTCMonth(),
    1
  );
  charts.all = [];
  for (let monthStart = allChartStart; monthStart < nowMs || charts.all.length === 0;) {
    const date = new Date(monthStart);
    const nextMonthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    const bucketEnd = Math.min(nextMonthStart, nowMs);
    charts.all.push({
      date: date.toISOString(),
      amount: historicalSales
        .filter((sale) => {
          const reviewedAt = Date.parse(sale.reviewedAt);
          return reviewedAt >= monthStart && reviewedAt <= bucketEnd &&
            (bucketEnd === nowMs || reviewedAt < bucketEnd);
        })
        .reduce((sum, sale) => sum + sale.amount, 0),
      granularity: 'month',
    });
    monthStart = nextMonthStart;
  }
  const payments = sqlite.prepare(`
    SELECT payments.id, payments.premium_request_id AS requestId,
           payments.user_id AS userId, users.name AS userName, users.email AS userEmail,
           payments.txn_ref AS txnRef, payments.plan, payments.amount, payments.currency,
           payments.status, payments.order_info AS orderInfo, payments.client_ip AS clientIp,
           payments.created_at AS createdAt, payments.expires_at AS expiresAt,
           payments.response_code AS responseCode, payments.transaction_status AS transactionStatus,
           payments.transaction_no AS transactionNo, payments.bank_code AS bankCode,
           payments.bank_tran_no AS bankTranNo, payments.card_type AS cardType,
           payments.pay_date AS payDate, payments.callback_at AS callbackAt,
           payments.vip_activated AS vipActivated
    FROM vnpay_payments AS payments
    LEFT JOIN users ON users.id = payments.user_id
    ORDER BY payments.id DESC
  `).all().map((payment) => ({
    ...payment,
    userName: payment.userName || 'Tài khoản đã xóa',
    userEmail: payment.userEmail || '',
    status: effectiveVnpayStatus(payment, now.getTime()),
    vipActivated: payment.vipActivated === 1,
  }));

  res.json({
    generatedAt: now.toISOString(),
    totals,
    charts,
    sales: approvedSales.sort((a, b) => Date.parse(b.reviewedAt) - Date.parse(a.reviewedAt)),
    payments,
  });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json(db.users.map(publicUser));
});

app.get('/api/admin/password-reset-requests', requireAdmin, (req, res) => {
  res.json(passwordResetRequestsForAdmin());
});

app.post('/api/admin/password-reset-requests/:id/review', requireAdmin, async (req, res) => {
  const request = sqlite.prepare(`
    SELECT id, user_id AS userId, status
    FROM password_reset_requests WHERE id = ?
  `).get([Number(req.params.id)]);
  if (!request) return res.status(404).json({ error: 'Không tìm thấy yêu cầu khôi phục mật khẩu' });
  if (request.status !== 'pending') {
    return res.status(409).json({ error: 'Yêu cầu khôi phục này đã được xử lý' });
  }
  const action = req.body && req.body.action;
  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'Thao tác duyệt không hợp lệ' });
  }

  const now = new Date();
  let resetToken;
  let expiresAt;
  sqlite.exec('BEGIN TRANSACTION;');
  try {
    sqlite.prepare(`
      UPDATE password_reset_requests
      SET status = ?, reviewed_at = ?, reviewed_by = ?
      WHERE id = ? AND status = 'pending'
    `).run([action === 'approve' ? 'approved' : 'rejected', now.toISOString(), req.user.id, request.id]);
    if (sqlite.prepare('SELECT changes() AS changes').get().changes !== 1) {
      throw new Error('Yêu cầu khôi phục này đã được xử lý');
    }
    if (action === 'approve') {
      resetToken = randomBytes(32).toString('base64url');
      expiresAt = new Date(now.getTime() + PASSWORD_RESET_TTL).toISOString();
      sqlite.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run([request.userId]);
      sqlite.prepare(`
        INSERT INTO password_reset_tokens (token_hash, user_id, created_at, expires_at, used_at)
        VALUES (?, ?, ?, ?, NULL)
      `).run([
        createHash('sha256').update(resetToken).digest('hex'),
        request.userId,
        now.toISOString(),
        expiresAt,
      ]);
    }
    sqlite.exec('COMMIT;');
  } catch (error) {
    sqlite.exec('ROLLBACK;');
    if (error.message === 'Yêu cầu khôi phục này đã được xử lý') {
      return res.status(409).json({ error: error.message });
    }
    throw error;
  }
  persistSqlite();
  const reviewedRequest = passwordResetRequestsForAdmin().find((item) => item.id === request.id);
  if (action === 'reject') return res.json({ request: reviewedRequest });

  const mailConfig = passwordResetEmailConfig();
  if (mailConfig) {
    try {
      await sendPasswordResetEmail(reviewedRequest.userEmail, resetToken, mailConfig);
      return res.json({
        request: reviewedRequest,
        deliveryMethod: 'email',
        expiresAt,
      });
    } catch (error) {
      console.error('Không thể gửi link đặt lại mật khẩu đã duyệt:', error);
    }
  }
  res.json({
    request: reviewedRequest,
    deliveryMethod: 'admin',
    token: resetToken,
    expiresAt,
  });
});

app.post('/api/admin/users/:id/password-reset', requireAdmin, (req, res) => {
  const user = db.users.find((candidate) => candidate.id === Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
  const { token, expiresAt } = issuePasswordResetToken(user.id);
  res.status(201).json({ token, expiresAt });
});

app.patch('/api/admin/users/:id', requireAdmin, (req, res) => {
  const user = db.users.find((candidate) => candidate.id === Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
  if (user.id === req.user.id) return res.status(400).json({ error: 'Không thể tự thay đổi quyền hoặc trạng thái tài khoản đang đăng nhập' });

  const { role, status } = req.body || {};
  if (role !== undefined && !['user', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Vai trò không hợp lệ' });
  }
  if (status !== undefined && !['active', 'blocked'].includes(status)) {
    return res.status(400).json({ error: 'Trạng thái không hợp lệ' });
  }

  const nextRole = role === undefined ? user.role : role;
  const nextStatus = status === undefined ? user.status : status;
  if (user.role === 'admin' && user.status === 'active' && (nextRole !== 'admin' || nextStatus !== 'active')) {
    const otherActiveAdmins = db.users.filter(
      (candidate) => candidate.id !== user.id && candidate.role === 'admin' && candidate.status === 'active'
    );
    if (!otherActiveAdmins.length) return res.status(409).json({ error: 'Phải luôn có ít nhất một admin đang hoạt động' });
  }

  user.role = nextRole;
  user.status = nextStatus;
  saveDb();
  res.json(publicUser(user));
});

app.get('/api/admin/songs', requireAdmin, (req, res) => {
  res.json(db.songs.map((song) => ({ ...song, ...enrichSong(song) })));
});

app.patch('/api/admin/songs/:id/vip', requireAdmin, (req, res) => {
  const song = db.songs.find((candidate) => candidate.id === Number(req.params.id));
  if (!song) return res.status(404).json({ error: 'Không tìm thấy bài hát' });
  if (typeof (req.body && req.body.isVip) !== 'boolean') {
    return res.status(400).json({ error: 'Trạng thái VIP phải là true hoặc false' });
  }
  song.isVip = req.body.isVip ? 1 : 0;
  saveDb();
  res.json({ ...song, ...enrichSong(song) });
});

app.patch('/api/admin/songs/:id/trending', requireAdmin, (req, res) => {
  const song = db.songs.find((candidate) => candidate.id === Number(req.params.id));
  if (!song) return res.status(404).json({ error: 'Không tìm thấy bài hát' });
  if (typeof (req.body && req.body.isTrending) !== 'boolean') {
    return res.status(400).json({ error: 'Trạng thái trend phải là true hoặc false' });
  }
  song.isTrending = req.body.isTrending ? 1 : 0;
  saveDb();
  res.json({ ...song, ...enrichSong(song) });
});

function validAudioUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  if (/^\/uploads\/audio\/[^/\\]+$/.test(value)) return true;
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function findOrCreateArtist(name) {
  const normalized = name.trim();
  let artist = db.artists.find((candidate) => candidate.name.toLowerCase() === normalized.toLowerCase());
  if (!artist) {
    artist = {
      id: nextId(db.artists),
      name: normalized,
      bio: '',
      avatar: `https://picsum.photos/seed/artist-${encodeURIComponent(normalized)}/400/400`,
    };
    db.artists.push(artist);
  }
  return artist;
}

app.post('/api/admin/songs', requireAdmin, (req, res) => {
  const body = req.body || {};
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const artistName = typeof body.artistName === 'string' ? body.artistName.trim() : '';
  const genre = typeof body.genre === 'string' ? body.genre.trim() : '';
  const audioUrl = typeof body.audioUrl === 'string' ? body.audioUrl.trim() : '';
  const albumId = body.albumId ? Number(body.albumId) : null;
  const duration = Number(body.duration) || 0;
  if (!title || title.length > 150) return res.status(400).json({ error: 'Tên bài hát phải có từ 1 đến 150 ký tự' });
  if (!artistName || artistName.length > 100) return res.status(400).json({ error: 'Vui lòng nhập tên nghệ sĩ (tối đa 100 ký tự)' });
  if (!genre || genre.length > 40) return res.status(400).json({ error: 'Vui lòng nhập thể loại (tối đa 40 ký tự)' });
  if (!validAudioUrl(audioUrl)) return res.status(400).json({ error: 'URL âm thanh phải là http(s) hoặc đường dẫn upload nội bộ hợp lệ' });
  if (body.albumId && !db.albums.some((album) => album.id === albumId)) {
    return res.status(400).json({ error: 'Album không tồn tại' });
  }
  if (!Number.isFinite(duration) || duration < 0) return res.status(400).json({ error: 'Thời lượng không hợp lệ' });

  const artist = findOrCreateArtist(artistName);
  const song = {
    id: nextId(db.songs),
    title,
    artistId: artist.id,
    albumId,
    genre,
    duration,
    audioUrl,
    cover: typeof body.cover === 'string' && body.cover.trim()
      ? body.cover.trim()
      : `https://picsum.photos/seed/admin-song-${Date.now()}/400/400`,
    lyrics: typeof body.lyrics === 'string' ? body.lyrics.slice(0, 50000) : '',
    plays: 0,
    userId: req.user.id,
    isVip: isBooleanFlag(body.isVip) ? 1 : 0,
  };
  db.songs.push(song);
  if (!db.genres.includes(genre)) db.genres.push(genre);
  saveDb();
  res.status(201).json({ ...song, ...enrichSong(song) });
});

app.put('/api/admin/songs/:id', requireAdmin, (req, res) => {
  const song = db.songs.find((candidate) => candidate.id === Number(req.params.id));
  if (!song) return res.status(404).json({ error: 'Không tìm thấy bài hát' });
  const body = req.body || {};
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const artistName = typeof body.artistName === 'string' ? body.artistName.trim() : '';
  const genre = typeof body.genre === 'string' ? body.genre.trim() : '';
  const audioUrl = typeof body.audioUrl === 'string' ? body.audioUrl.trim() : '';
  const albumId = body.albumId ? Number(body.albumId) : null;
  const duration = Number(body.duration) || 0;
  if (!title || title.length > 150) return res.status(400).json({ error: 'Tên bài hát phải có từ 1 đến 150 ký tự' });
  if (!artistName || artistName.length > 100) return res.status(400).json({ error: 'Vui lòng nhập tên nghệ sĩ (tối đa 100 ký tự)' });
  if (!genre || genre.length > 40) return res.status(400).json({ error: 'Vui lòng nhập thể loại (tối đa 40 ký tự)' });
  if (!validAudioUrl(audioUrl)) return res.status(400).json({ error: 'URL âm thanh phải là http(s) hoặc đường dẫn upload nội bộ hợp lệ' });
  if (body.albumId && !db.albums.some((album) => album.id === albumId)) {
    return res.status(400).json({ error: 'Album không tồn tại' });
  }
  if (!Number.isFinite(duration) || duration < 0) return res.status(400).json({ error: 'Thời lượng không hợp lệ' });

  const artist = findOrCreateArtist(artistName);
  song.title = title;
  song.artistId = artist.id;
  song.albumId = albumId;
  song.genre = genre;
  song.audioUrl = audioUrl;
  song.duration = duration;
  if (body.isVip !== undefined) song.isVip = isBooleanFlag(body.isVip) ? 1 : 0;
  song.cover = typeof body.cover === 'string' && body.cover.trim() ? body.cover.trim() : song.cover;
  song.lyrics = typeof body.lyrics === 'string' ? body.lyrics.slice(0, 50000) : song.lyrics || '';
  if (!db.genres.includes(genre)) db.genres.push(genre);
  saveDb();
  res.json({ ...song, ...enrichSong(song) });
});

app.delete('/api/admin/songs/:id', requireAdmin, (req, res) => {
  const index = db.songs.findIndex((song) => song.id === Number(req.params.id));
  if (index === -1) return res.status(404).json({ error: 'Không tìm thấy bài hát' });
  const [song] = db.songs.splice(index, 1);
  db.playlists.forEach((playlist) => {
    playlist.songIds = playlist.songIds.filter((songId) => songId !== song.id);
  });
  if (song.audioUrl.startsWith('/uploads/audio/')) {
    fs.unlink(path.join(ROOT, song.audioUrl), (error) => {
      if (error && error.code !== 'ENOENT') console.error('Không xóa được file nhạc:', error);
    });
  }
  saveDb();
  res.json({ ok: true });
});

app.get('/api/admin/albums', requireAdmin, (req, res) => {
  res.json(db.albums.map(enrichAlbum));
});

app.post('/api/admin/albums', requireAdmin, (req, res) => {
  const body = req.body || {};
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const artistId = Number(body.artistId);
  const year = Number(body.year);
  if (!title || title.length > 120) return res.status(400).json({ error: 'Tên album phải có từ 1 đến 120 ký tự' });
  if (!db.artists.some((artist) => artist.id === artistId)) return res.status(400).json({ error: 'Nghệ sĩ không tồn tại' });
  if (!Number.isInteger(year) || year < 1 || year > 9999) return res.status(400).json({ error: 'Năm phát hành không hợp lệ' });
  const album = {
    id: nextId(db.albums),
    title,
    artistId,
    year,
    cover: typeof body.cover === 'string' && body.cover.trim()
      ? body.cover.trim()
      : `https://picsum.photos/seed/admin-album-${Date.now()}/400/400`,
  };
  db.albums.push(album);
  saveDb();
  res.status(201).json(enrichAlbum(album));
});

app.put('/api/admin/albums/:id', requireAdmin, (req, res) => {
  const album = db.albums.find((candidate) => candidate.id === Number(req.params.id));
  if (!album) return res.status(404).json({ error: 'Không tìm thấy album' });
  const body = req.body || {};
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const artistId = Number(body.artistId);
  const year = Number(body.year);
  if (!title || title.length > 120) return res.status(400).json({ error: 'Tên album phải có từ 1 đến 120 ký tự' });
  if (!db.artists.some((artist) => artist.id === artistId)) return res.status(400).json({ error: 'Nghệ sĩ không tồn tại' });
  if (!Number.isInteger(year) || year < 1 || year > 9999) return res.status(400).json({ error: 'Năm phát hành không hợp lệ' });
  album.title = title;
  album.artistId = artistId;
  album.year = year;
  if (typeof body.cover === 'string' && body.cover.trim()) album.cover = body.cover.trim();
  saveDb();
  res.json(enrichAlbum(album));
});

app.delete('/api/admin/albums/:id', requireAdmin, (req, res) => {
  const index = db.albums.findIndex((album) => album.id === Number(req.params.id));
  if (index === -1) return res.status(404).json({ error: 'Không tìm thấy album' });
  const [album] = db.albums.splice(index, 1);
  db.songs.forEach((song) => {
    if (song.albumId === album.id) song.albumId = null;
  });
  saveDb();
  res.json({ ok: true });
});

app.get('/api/admin/genres', requireAdmin, (req, res) => {
  res.json(db.genres);
});

app.post('/api/admin/genres', requireAdmin, (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 40) return res.status(400).json({ error: 'Tên thể loại phải có từ 1 đến 40 ký tự' });
  if (db.genres.some((genre) => genre.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: 'Thể loại này đã tồn tại' });
  }
  db.genres.push(name);
  saveDb();
  res.status(201).json({ name });
});

app.put('/api/admin/genres/:name', requireAdmin, (req, res) => {
  const oldName = req.params.name;
  const index = db.genres.findIndex((genre) => genre === oldName);
  if (index === -1) return res.status(404).json({ error: 'Không tìm thấy thể loại' });
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 40) return res.status(400).json({ error: 'Tên thể loại phải có từ 1 đến 40 ký tự' });
  if (db.genres.some((genre, genreIndex) => genreIndex !== index && genre.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: 'Thể loại này đã tồn tại' });
  }
  db.genres[index] = name;
  db.songs.forEach((song) => {
    if (song.genre === oldName) song.genre = name;
  });
  saveDb();
  res.json({ name });
});

app.delete('/api/admin/genres/:name', requireAdmin, (req, res) => {
  const index = db.genres.findIndex((genre) => genre === req.params.name);
  if (index === -1) return res.status(404).json({ error: 'Không tìm thấy thể loại' });
  const [removed] = db.genres.splice(index, 1);
  db.songs.forEach((song) => {
    if (song.genre === removed) song.genre = 'Khác';
  });
  if (!db.genres.includes('Khác')) db.genres.push('Khác');
  saveDb();
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* 6. API: SONGS                                                       */
/* ------------------------------------------------------------------ */

// GET /api/songs?q=keyword  – danh sách / tìm kiếm bài hát
app.get('/api/songs', (req, res) => {
  const q = (req.query.q || '').toString().trim().toLowerCase();
  let songs = db.songs.map(enrichSong);
  if (q) {
    songs = songs.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.artistName.toLowerCase().includes(q) ||
        (s.albumTitle || '').toLowerCase().includes(q) ||
        (s.genre || '').toLowerCase().includes(q)
    );
  }
  res.json(songs);
});

app.get('/api/premium/songs', requireAuth, (req, res) => {
  if (!hasActivePremium(req.user)) {
    return res.status(403).json({ error: 'Kho nhạc này chỉ dành cho tài khoản VIP còn hạn.' });
  }
  res.json(db.songs.filter((song) => song.isVip === true || song.isVip === 1).map(enrichSong));
});

app.get('/api/favorites', requireAuth, (req, res) => {
  const songIds = new Set(
    db.favorites.filter((favorite) => favorite.userId === req.user.id).map((favorite) => favorite.songId)
  );
  res.json(db.songs.filter((song) => songIds.has(song.id)).map(enrichSong));
});

app.post('/api/favorites/:songId', requireAuth, (req, res) => {
  const songId = Number(req.params.songId);
  if (!Number.isInteger(songId) || !db.songs.some((song) => song.id === songId)) {
    return res.status(404).json({ error: 'Không tìm thấy bài hát' });
  }
  if (db.favorites.some((favorite) => favorite.userId === req.user.id && favorite.songId === songId)) {
    return res.status(409).json({ error: 'Bài hát đã có trong danh sách yêu thích' });
  }
  db.favorites.push({ userId: req.user.id, songId });
  saveDb();
  res.status(201).json({ ok: true });
});

app.delete('/api/favorites/:songId', requireAuth, (req, res) => {
  const songId = Number(req.params.songId);
  db.favorites = db.favorites.filter(
    (favorite) => favorite.userId !== req.user.id || favorite.songId !== songId
  );
  saveDb();
  res.json({ ok: true });
});

// GET /api/songs/:id
app.get('/api/songs/:id', (req, res) => {
  const song = db.songs.find((s) => s.id === Number(req.params.id));
  if (!song) return res.status(404).json({ error: 'Không tìm thấy bài hát' });
  res.json(enrichSong(song));
});

// POST /api/songs/:id/play  – tăng lượt nghe (client gọi khi bài bắt đầu phát)
app.post('/api/songs/:id/play', (req, res) => {
  const song = db.songs.find((s) => s.id === Number(req.params.id));
  if (!song) return res.status(404).json({ error: 'Không tìm thấy bài hát' });
  const listener = currentUser(req);
  if (song.isVip && !hasActivePremium(listener)) {
    return res.status(403).json({ error: 'Bài hát này dành riêng cho tài khoản VIP. Vui lòng nâng cấp để nghe!' });
  }
  song.plays = (song.plays || 0) + 1;
  const artist = db.artists.find((candidate) => candidate.id === song.artistId);
  const playedAt = new Date().toISOString();
  saveDb(listener ? () => {
    sqlite.prepare(`
      INSERT INTO listening_history (
        user_id, user_name, user_email, song_id, song_title, artist_name, played_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run([
      listener.id,
      listener.name,
      listener.email,
      song.id,
      song.title,
      artist ? artist.name : 'Không rõ',
      playedAt,
    ]);
  } : null);
  res.json({ plays: song.plays });
});

// POST /api/songs  – upload bài hát mới
// multipart fields: title, artistId | artistName, albumId?, genre?, duration?
// files:            audio (bắt buộc), cover (tùy chọn)
app.post(
  '/api/songs',
  requireAuth,
  upload.fields([
    { name: 'audio', maxCount: 1 },
    { name: 'cover', maxCount: 1 },
  ]),
  (req, res) => {
    const audioFile = req.files && req.files.audio && req.files.audio[0];
    const coverFile = req.files && req.files.cover && req.files.cover[0];
    const title = (req.body.title || '').trim();

    // Nếu dữ liệu không hợp lệ thì xóa file vừa upload để tránh rác
    const cleanup = () => {
      [audioFile, coverFile].filter(Boolean).forEach((f) => fs.unlink(f.path, () => {}));
    };

    if (!audioFile) {
      cleanup();
      return res.status(400).json({ error: 'Vui lòng chọn file âm thanh' });
    }
    if (!title) {
      cleanup();
      return res.status(400).json({ error: 'Vui lòng nhập tên bài hát' });
    }

    // Xác định nghệ sĩ: chọn sẵn (artistId) hoặc tạo mới (artistName)
    let artist = db.artists.find((a) => a.id === Number(req.body.artistId));
    if (!artist) {
      const name = (req.body.artistName || '').trim();
      if (!name) {
        cleanup();
        return res.status(400).json({ error: 'Vui lòng chọn hoặc nhập tên nghệ sĩ' });
      }
      artist = db.artists.find((a) => a.name.toLowerCase() === name.toLowerCase());
      if (!artist) {
        artist = {
          id: nextId(db.artists),
          name,
          bio: '',
          avatar: `https://picsum.photos/seed/artist-${encodeURIComponent(name)}/400/400`,
        };
        db.artists.push(artist);
      }
    }

    const album = db.albums.find((a) => a.id === Number(req.body.albumId));
    const cover = coverFile
      ? `/uploads/covers/${coverFile.filename}`
      : album
      ? album.cover
      : `https://picsum.photos/seed/song-${Date.now()}/400/400`;

    const song = {
      id: nextId(db.songs),
      title,
      artistId: artist.id,
      albumId: album ? album.id : null,
      genre: (req.body.genre || 'Khác').trim(),
      duration: Number(req.body.duration) || 0,
      audioUrl: `/uploads/audio/${audioFile.filename}`, // đường dẫn nội bộ
      cover,
      plays: 0,
      userId: req.user.id,
    };
    db.songs.push(song);
    saveDb();
    res.status(201).json(enrichSong(song));
  }
);

// DELETE /api/songs/:id  – xóa bài hát (chỉ xóa file nếu là bài upload)
app.delete('/api/songs/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const idx = db.songs.findIndex((s) => s.id === id && s.userId === req.user.id);
  if (idx === -1) return res.status(404).json({ error: 'Không tìm thấy bài hát' });

  const [song] = db.songs.splice(idx, 1);
  db.playlists.forEach((pl) => (pl.songIds = pl.songIds.filter((sid) => sid !== id)));
  if (song.audioUrl.startsWith('/uploads/audio/')) {
    fs.unlink(path.join(ROOT, song.audioUrl), () => {});
  }
  saveDb();
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* 6. API: AUDIO STREAMING                                             */
/* ------------------------------------------------------------------ */

const MIME = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
};

function parseByteRange(rangeHeader, size) {
  if (typeof rangeHeader !== 'string' || !rangeHeader.startsWith('bytes=') || rangeHeader.includes(',')) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match || (!match[1] && !match[2]) || size <= 0) return null;

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
      return null;
    }
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

// GET /api/stream/:id
// Hỗ trợ header "Range: bytes=start-end" để trình duyệt tua và tải theo từng phần.
app.get('/api/stream/:id', async (req, res) => {
  const song = db.songs.find((s) => s.id === Number(req.params.id));
  if (!song) return res.status(404).json({ error: 'Không tìm thấy bài hát' });
  if (song.isVip && !hasActivePremium(currentUser(req))) {
    return res.status(403).json({ error: 'Bài hát này dành riêng cho tài khoản VIP. Vui lòng nâng cấp để nghe!' });
  }

  /* --- Trường hợp 1: file đã upload lên server --- */
  if (song.audioUrl.startsWith('/uploads/audio/')) {
    const filePath = path.join(ROOT, song.audioUrl);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return res.status(404).json({ error: 'File âm thanh không tồn tại' });
    }

    const size = stat.size;
    const contentType = MIME[path.extname(filePath).toLowerCase()] || 'audio/mpeg';
    const range = req.headers.range;

    if (!range) {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': size,
        'Accept-Ranges': 'bytes',
      });
      return fs.createReadStream(filePath).pipe(res);
    }

    const byteRange = parseByteRange(range, size);
    if (!byteRange) {
      res.writeHead(416, {
        'Content-Range': `bytes */${size}`,
        'Accept-Ranges': 'bytes',
      });
      return res.end();
    }
    const { start, end } = byteRange;

    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
    });
    return fs.createReadStream(filePath, { start, end })
      .on('error', (error) => {
        console.error('Lỗi đọc đoạn âm thanh:', error);
        if (!res.headersSent) res.status(500).end();
        else res.destroy(error);
      })
      .pipe(res);
  }

  /* --- Trường hợp 2: link mp3 online → proxy lại, giữ nguyên Range --- */
  const controller = new AbortController();
  res.on('close', () => controller.abort()); // client ngắt kết nối thì dừng tải
  try {
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    const upstream = await fetch(song.audioUrl, { headers, signal: controller.signal });

    if (!upstream.ok && upstream.status !== 206) {
      return res.status(502).json({ error: 'Không tải được nguồn nhạc' });
    }
    res.status(upstream.status);
    ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach((h) => {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    });
    if (!upstream.headers.get('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');
    Readable.fromWeb(upstream.body).on('error', () => res.end()).pipe(res);
  } catch (err) {
    if (err.name !== 'AbortError' && !res.headersSent) {
      res.status(502).json({ error: 'Lỗi khi stream nhạc từ nguồn ngoài' });
    }
  }
});

/* ------------------------------------------------------------------ */
/* 7. API: ALBUMS & ARTISTS                                            */
/* ------------------------------------------------------------------ */

function enrichAlbum(album) {
  const artist = db.artists.find((a) => a.id === album.artistId);
  return {
    ...album,
    artistName: artist ? artist.name : 'Không rõ',
    songCount: db.songs.filter((s) => s.albumId === album.id).length,
  };
}

app.get('/api/albums', (req, res) => res.json(db.albums.map(enrichAlbum)));
app.get('/api/genres', (req, res) => res.json(db.genres));

app.get('/api/albums/:id', (req, res) => {
  const album = db.albums.find((a) => a.id === Number(req.params.id));
  if (!album) return res.status(404).json({ error: 'Không tìm thấy album' });
  res.json({
    ...enrichAlbum(album),
    songs: db.songs.filter((s) => s.albumId === album.id).map(enrichSong),
  });
});

app.get('/api/artists', (req, res) => res.json(db.artists));

app.get('/api/artists/:id', (req, res) => {
  const artist = db.artists.find((a) => a.id === Number(req.params.id));
  if (!artist) return res.status(404).json({ error: 'Không tìm thấy nghệ sĩ' });
  res.json({
    ...artist,
    albums: db.albums.filter((a) => a.artistId === artist.id).map(enrichAlbum),
    songs: db.songs.filter((s) => s.artistId === artist.id).map(enrichSong),
  });
});

/* ------------------------------------------------------------------ */
/* 8. API: PLAYLISTS                                                   */
/* ------------------------------------------------------------------ */

app.get('/api/playlists', (req, res) => {
  const user = currentUser(req);
  res.json(visiblePlaylists(user ? user.id : null).map((pl) => enrichPlaylist(pl, user ? user.id : null)));
});

app.get('/api/playlists/:id', (req, res) => {
  const user = currentUser(req);
  const pl = visiblePlaylists(user ? user.id : null).find((p) => p.id === Number(req.params.id));
  if (!pl) return res.status(404).json({ error: 'Không tìm thấy playlist' });
  res.json(enrichPlaylist(pl, user ? user.id : null));
});

// POST /api/playlists  body: { name }
app.post('/api/playlists', requireAuth, (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'Vui lòng nhập tên playlist' });
  const pl = { id: nextId(db.playlists), name, songIds: [], userId: req.user.id };
  db.playlists.push(pl);
  saveDb();
  res.status(201).json(enrichPlaylist(pl, req.user.id));
});

// PUT /api/playlists/:id  body: { name }  – đổi tên
app.put('/api/playlists/:id', requireAuth, (req, res) => {
  const pl = db.playlists.find((p) => p.id === Number(req.params.id) && p.userId === req.user.id);
  if (!pl) return res.status(404).json({ error: 'Không tìm thấy playlist' });
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'Tên playlist không được để trống' });
  pl.name = name;
  saveDb();
  res.json(enrichPlaylist(pl, req.user.id));
});

app.delete('/api/playlists/:id', requireAuth, (req, res) => {
  const idx = db.playlists.findIndex((p) => p.id === Number(req.params.id) && p.userId === req.user.id);
  if (idx === -1) return res.status(404).json({ error: 'Không tìm thấy playlist' });
  db.playlists.splice(idx, 1);
  saveDb();
  res.json({ ok: true });
});

// POST /api/playlists/:id/songs  body: { songId } – thêm bài vào playlist
app.post('/api/playlists/:id/songs', requireAuth, (req, res) => {
  const pl = db.playlists.find((p) => p.id === Number(req.params.id) && p.userId === req.user.id);
  if (!pl) return res.status(404).json({ error: 'Không tìm thấy playlist' });
  const songId = Number(req.body.songId);
  if (!db.songs.some((s) => s.id === songId)) {
    return res.status(404).json({ error: 'Không tìm thấy bài hát' });
  }
  if (pl.songIds.includes(songId)) {
    return res.status(409).json({ error: 'Bài hát đã có trong playlist' });
  }
  pl.songIds.push(songId);
  saveDb();
  res.status(201).json(enrichPlaylist(pl, req.user.id));
});

// DELETE /api/playlists/:id/songs/:songId – bỏ bài khỏi playlist
app.delete('/api/playlists/:id/songs/:songId', requireAuth, (req, res) => {
  const pl = db.playlists.find((p) => p.id === Number(req.params.id) && p.userId === req.user.id);
  if (!pl) return res.status(404).json({ error: 'Không tìm thấy playlist' });
  pl.songIds = pl.songIds.filter((id) => id !== Number(req.params.songId));
  saveDb();
  res.json(enrichPlaylist(pl, req.user.id));
});

/* ------------------------------------------------------------------ */
/* 9. XỬ LÝ LỖI CHUNG                                                  */
/* ------------------------------------------------------------------ */

// Lỗi từ multer (file quá lớn, sai định dạng...) và các lỗi khác
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File quá lớn (tối đa 30MB)' : err.message;
    return res.status(400).json({ error: msg });
  }
  console.error(err);
  res.status(400).json({ error: err.message || 'Có lỗi xảy ra' });
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => console.log(`Music app đang chạy tại http://localhost:${PORT}`));
  })
  .catch((error) => {
    console.error('Không khởi tạo được SQLite:', error);
    process.exitCode = 1;
  });