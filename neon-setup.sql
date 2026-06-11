-- Run this once in your Neon console (SQL Editor tab)
-- https://console.neon.tech → your project → SQL Editor

CREATE TABLE IF NOT EXISTS hub_state (
  id          INTEGER PRIMARY KEY DEFAULT 1,
  apps        JSONB NOT NULL DEFAULT '[]',
  notes       JSONB NOT NULL DEFAULT '[]',
  quick_links JSONB NOT NULL DEFAULT '[]',
  stages      JSONB NOT NULL DEFAULT '{}',
  saved_views JSONB NOT NULL DEFAULT '[]',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT single_row CHECK (id = 1)
);

-- Insert the one and only row (safe to run multiple times)
INSERT INTO hub_state (id) VALUES (1) ON CONFLICT DO NOTHING;
