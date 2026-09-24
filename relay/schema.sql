-- Ranch relay database (Cloudflare D1). Safe to re-run: every statement is idempotent.
CREATE TABLE IF NOT EXISTS rain (
  date    TEXT PRIMARY KEY,      -- local date YYYY-MM-DD
  gauge   REAL,                  -- inches from the on-site gauge (null if none)
  est     REAL,                  -- inches from the weather model (null if not fetched)
  updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cameras (
  id         TEXT PRIMARY KEY,
  name       TEXT,
  battery    REAL,
  signal     REAL,
  lat        REAL,
  lon        REAL,
  last_photo TEXT,
  updated    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS photos (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,  -- sync cursor for the app
  id         TEXT UNIQUE NOT NULL,
  camera_id  TEXT,
  camera     TEXT,
  taken      TEXT,                               -- ISO UTC
  lat        REAL,
  lon        REAL,
  temp       REAL,
  moon       TEXT,
  battery    REAL,
  signal     REAL,
  bytes      INTEGER,
  chunks     INTEGER DEFAULT 0,
  fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS photos_taken ON photos(taken);
CREATE TABLE IF NOT EXISTS photo_chunks (
  id   TEXT NOT NULL,
  n    INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (id, n)
);
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT
);
