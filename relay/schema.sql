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
-- AI labels for camera photos (filled by the classifier when ANTHROPIC_API_KEY is set).
CREATE TABLE IF NOT EXISTS photo_labels (
  id       TEXT PRIMARY KEY,               -- photos.id
  url      TEXT,                           -- Tactacam's presigned URL (valid ~7 days)
  status   TEXT NOT NULL DEFAULT 'pending',-- pending | done | error | skipped
  attempts INTEGER NOT NULL DEFAULT 0,
  tags     TEXT,                           -- comma-separated: buck, doe, hog, predator, person…
  summary  TEXT,                           -- one line, e.g. "2 does and a fawn at the feeder"
  labels   TEXT,                           -- full JSON result
  model    TEXT,
  updated  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS photo_labels_status ON photo_labels(status, updated);
