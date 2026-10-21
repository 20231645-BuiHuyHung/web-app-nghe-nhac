'use strict';

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = process.env.MUSIC_DB_FILE
  ? path.resolve(process.env.MUSIC_DB_FILE)
  : path.join(DATA_DIR, 'music.sqlite');
const TEMP_DB_FILE = `${DB_FILE}.tmp`;

const tracks = [
  ['Paper Skies', 'Lofi Garden', 'Quiet Hours', 'Lofi', '2025', 0],
  ['Window Seat', 'Lofi Garden', 'Quiet Hours', 'Lofi', '2025', 0],
  ['Soft Focus', 'Lofi Garden', 'Quiet Hours', 'Lofi', '2025', 0],
  ['City in Bloom', 'June Avenue', 'Color Theory', 'Pop', '2025', 0],
  ['Satellite Hearts', 'June Avenue', 'Color Theory', 'Pop', '2025', 0],
  ['First Light Again', 'June Avenue', 'Color Theory', 'Pop', '2025', 0],
  ['Voltage Dreams', 'Neon Current', 'After Hours', 'EDM', '2025', 0],
  ['Gravity Loop', 'Neon Current', 'After Hours', 'EDM', '2025', 0],
  ['Night Runner', 'Neon Current', 'After Hours', 'EDM', '2025', 0],
  ['Open Road Home', 'Milo Hart', 'Wood & Wire', 'Acoustic', '2024', 0],
  ['Honey on the Radio', 'Milo Hart', 'Wood & Wire', 'Acoustic', '2024', 0],
  ['Small Town Moon', 'Milo Hart', 'Wood & Wire', 'Acoustic', '2024', 0],
  ['Glasshouse Waltz', 'Ada Laurent', 'Stillwater', 'Classical', '2024', 0],
  ['Letters in Blue', 'Ada Laurent', 'Stillwater', 'Classical', '2024', 0],
  ['The Long Way Round', 'Ada Laurent', 'Stillwater', 'Classical', '2024', 0],
  ['Corner Store Stories', 'Southside Poet', 'Block by Block', 'HipHop', '2025', 0],
  ['No Small Plans', 'Southside Poet', 'Block by Block', 'HipHop', '2025', 0],
  ['Sunday on Repeat', 'Southside Poet', 'Block by Block', 'HipHop', '2025', 0],
  ['Golden Hour Drive', 'The Paper Satellites', 'Signal Fires', 'Rock', '2024', 0],
  ['Static Flowers', 'The Paper Satellites', 'Signal Fires', 'Rock', '2024', 0],
  ['Run Toward the Sound', 'The Paper Satellites', 'Signal Fires', 'Rock', '2024', 0],
  ['Blue Note Morning', 'Mira Sol', 'Velvet Room', 'Jazz', '2025', 0],
  ['Velvet Side Street', 'Mira Sol', 'Velvet Room', 'Jazz', '2025', 1],
  ['Slow Dancing Alone', 'Mira Sol', 'Velvet Room', 'Jazz', '2025', 1],
  ['Ocean Between Us', 'Aster Vale', 'Farther Shore', 'Pop', '2025', 1],
  ['Comet Season', 'Aster Vale', 'Farther Shore', 'Synthwave', '2025', 1],
  ['Tidal Memory', 'Aster Vale', 'Farther Shore', 'Synthwave', '2025', 1],
  ['Beneath the Noise', 'Cedar & Stone', 'Wild Silence', 'Acoustic', '2024', 1],
  ['Northbound', 'Cedar & Stone', 'Wild Silence', 'Folk', '2024', 1],
  ['A Place to Begin', 'Cedar & Stone', 'Wild Silence', 'Folk', '2024', 1],
];

const coverPhotos = [
  'photo-1511379938547-c1f69419868d',
  'photo-1516280440614-37939bbacd81',
  'photo-1510915361894-db8b60106cb1',
  'photo-1516450360452-9312f5e86fc7',
  'photo-1493225457124-a3eb161ffa5f',
  'photo-1514525253161-7a46d19cd819',
  'photo-1506157786151-b8491531f063',
  'photo-1470225620780-dba8ba36b745',
];

function coverUrl(index) {
  const photo = coverPhotos[index % coverPhotos.length];
  return `https://images.unsplash.com/${photo}?auto=format&fit=crop&w=640&q=80`;
}

function rowsFor(db, sql, params = []) {
  const statement = db.prepare(sql);
  try {
    statement.bind(params);
    const rows = [];
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally {
    statement.free();
  }
}

function run(db, sql, params = []) {
  const statement = db.prepare(sql);
  try {
    statement.run(params);
  } finally {
    statement.free();
  }
}

function ensureColumn(db, table, column, definition) {
  const columns = rowsFor(db, `PRAGMA table_info(${table})`);
  if (!columns.some((item) => item.name === column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const db = new SQL.Database(
    fs.existsSync(DB_FILE) ? new Uint8Array(fs.readFileSync(DB_FILE)) : undefined
  );

  try {
    db.run('PRAGMA foreign_keys = ON');
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
        is_premium INTEGER NOT NULL DEFAULT 0 CHECK (is_premium IN (0, 1)),
        premium_expires_at TEXT,
        session_version INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS artists (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        bio TEXT NOT NULL DEFAULT '',
        avatar TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS albums (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        artist_id INTEGER NOT NULL REFERENCES artists(id),
        year INTEGER NOT NULL,
        cover TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS songs (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        artist_id INTEGER NOT NULL REFERENCES artists(id),
        album_id INTEGER REFERENCES albums(id) ON DELETE SET NULL,
        genre TEXT NOT NULL DEFAULT 'Khác',
        duration REAL NOT NULL DEFAULT 0,
        audio_url TEXT NOT NULL,
        cover TEXT NOT NULL DEFAULT '',
        plays INTEGER NOT NULL DEFAULT 0,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        lyrics TEXT NOT NULL DEFAULT '',
        is_vip INTEGER NOT NULL DEFAULT 0 CHECK (is_vip IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS genres (
        name TEXT NOT NULL PRIMARY KEY COLLATE NOCASE
      );
    `);
    ensureColumn(db, 'songs', 'lyrics', "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, 'songs', 'is_vip', 'INTEGER NOT NULL DEFAULT 0');

    const songColumns = new Set(rowsFor(db, 'PRAGMA table_info(songs)').map((item) => item.name));
    const requiredColumns = ['title', 'artist_id', 'album_id', 'genre', 'duration', 'audio_url', 'cover', 'plays', 'is_vip'];
    const missingColumns = requiredColumns.filter((column) => !songColumns.has(column));
    if (missingColumns.length) {
      throw new Error(
        `Bảng songs không tương thích với ứng dụng. Thiếu cột: ${missingColumns.join(', ')}`
      );
    }

    db.run('BEGIN TRANSACTION');
    try {
      const artists = new Map();
      const albums = new Map();
      const genres = new Set();

      for (let index = 0; index < tracks.length; index += 1) {
        const [title, artistName, albumTitle, genre, year, isVip] = tracks[index];
        const audioNumber = (index % 17) + 1;
        const audioUrl = `https://www.soundhelix.com/examples/mp3/SoundHelix-Song-${audioNumber}.mp3`;
        let artistId = artists.get(artistName);

        if (!artistId) {
          const existingArtist = rowsFor(db, 'SELECT id FROM artists WHERE name = ? LIMIT 1', [artistName])[0];
          if (existingArtist) {
            artistId = existingArtist.id;
          } else {
            run(db, 'INSERT INTO artists (name, bio, avatar) VALUES (?, ?, ?)', [
              artistName,
              'Nghệ sĩ mẫu được thêm bởi seed.js.',
              coverUrl(index),
            ]);
            artistId = rowsFor(db, 'SELECT last_insert_rowid() AS id')[0].id;
          }
          artists.set(artistName, artistId);
        }

        const albumKey = `${artistId}:${albumTitle}`;
        let albumId = albums.get(albumKey);
        if (!albumId) {
          const existingAlbum = rowsFor(
            db,
            'SELECT id FROM albums WHERE artist_id = ? AND title = ? LIMIT 1',
            [artistId, albumTitle]
          )[0];
          if (existingAlbum) {
            albumId = existingAlbum.id;
          } else {
            run(db, 'INSERT INTO albums (title, artist_id, year, cover) VALUES (?, ?, ?, ?)', [
              albumTitle,
              artistId,
              Number(year),
              coverUrl(index),
            ]);
            albumId = rowsFor(db, 'SELECT last_insert_rowid() AS id')[0].id;
          }
          albums.set(albumKey, albumId);
        }

        const existingSong = rowsFor(
          db,
          'SELECT id FROM songs WHERE title = ? AND artist_id = ? LIMIT 1',
          [title, artistId]
        )[0];
        if (existingSong) {
          run(db, 'UPDATE songs SET audio_url = ?, is_vip = ? WHERE id = ?', [
            audioUrl,
            isVip,
            existingSong.id,
          ]);
        } else {
          run(db, `
            INSERT INTO songs (
              title, artist_id, album_id, genre, duration, audio_url, cover, plays, is_vip
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            title,
            artistId,
            albumId,
            genre,
            180 + ((index * 37) % 181),
            audioUrl,
            coverUrl(index),
            100 + Math.floor(Math.random() * 4901),
            isVip,
          ]);
        }
        genres.add(genre);
      }

      for (const genre of genres) {
        run(db, 'INSERT OR IGNORE INTO genres (name) VALUES (?)', [genre]);
      }
      db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    }

    const seededCount = rowsFor(db, `
      SELECT COUNT(*) AS count FROM songs
      WHERE title IN (${tracks.map(() => '?').join(', ')})
    `, tracks.map(([title]) => title))[0].count;
    if (seededCount !== tracks.length) {
      throw new Error(`Chỉ xác nhận được ${seededCount}/${tracks.length} bài hát mẫu.`);
    }

    fs.writeFileSync(TEMP_DB_FILE, Buffer.from(db.export()));
    fs.renameSync(TEMP_DB_FILE, DB_FILE);
    console.log('Đã seed thành công 30 bài hát vào database SQLite!');
  } finally {
    db.close();
    if (fs.existsSync(TEMP_DB_FILE)) fs.unlinkSync(TEMP_DB_FILE);
  }
}

main().catch((error) => {
  console.error('Seed database thất bại:', error.message);
  process.exitCode = 1;
});
