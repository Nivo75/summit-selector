-- Summit Selector Database Schema
-- Run this once in Supabase SQL Editor (supabase.com → your project → SQL Editor)

-- ─── LISTS ────────────────────────────────────────────────────────────────────
-- Each named summit list (e.g. "US State Highpoints", "Colorado 14ers")
CREATE TABLE IF NOT EXISTS lists (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text UNIQUE NOT NULL,   -- URL-safe identifier, e.g. "us-state-highpoints"
  name        text NOT NULL,          -- Display name, e.g. "US State Highpoints"
  description text,
  peak_count  int DEFAULT 0,
  created_at  timestamptz DEFAULT now()
);

-- ─── PEAKS ────────────────────────────────────────────────────────────────────
-- Individual peaks (a peak can appear on multiple lists)
CREATE TABLE IF NOT EXISTS peaks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  state          text,
  elevation_ft   int,
  latitude       numeric(10, 6),
  longitude      numeric(10, 6),
  prominence_ft  int,
  peak_type      text,
  source_url     text,
  created_at     timestamptz DEFAULT now()
);

-- ─── LIST_PEAKS ───────────────────────────────────────────────────────────────
-- Junction table: which peaks belong to which lists, with rank order
CREATE TABLE IF NOT EXISTS list_peaks (
  list_id  uuid REFERENCES lists(id) ON DELETE CASCADE,
  peak_id  uuid REFERENCES peaks(id) ON DELETE CASCADE,
  rank     int,   -- Position within the list (1 = first/highest/etc.)
  PRIMARY KEY (list_id, peak_id)
);

-- ─── INDEXES ──────────────────────────────────────────────────────────────────
-- Speed up lookups when filtering by list
CREATE INDEX IF NOT EXISTS idx_list_peaks_list_id ON list_peaks(list_id);

-- Speed up geographic proximity queries (lat/lon range filters)
CREATE INDEX IF NOT EXISTS idx_peaks_lat  ON peaks(latitude);
CREATE INDEX IF NOT EXISTS idx_peaks_lon  ON peaks(longitude);

-- ─── ROW LEVEL SECURITY ───────────────────────────────────────────────────────
-- Allow public read access (no auth required to browse peaks)
ALTER TABLE lists      ENABLE ROW LEVEL SECURITY;
ALTER TABLE peaks      ENABLE ROW LEVEL SECURITY;
ALTER TABLE list_peaks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read lists"      ON lists      FOR SELECT USING (true);
CREATE POLICY "Public read peaks"      ON peaks      FOR SELECT USING (true);
CREATE POLICY "Public read list_peaks" ON list_peaks FOR SELECT USING (true);
