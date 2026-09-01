-- ============================================================
-- MIGRATION SUPABASE - PERSISTANCE DES ESCALADES
-- À exécuter dans Supabase > SQL Editor.
-- ============================================================

CREATE TABLE IF NOT EXISTS escalation_logs (
  id         TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_escalation_logs_created_at
  ON escalation_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_escalation_logs_status
  ON escalation_logs ((data->>'status'));

CREATE INDEX IF NOT EXISTS idx_escalation_logs_from
  ON escalation_logs ((data->>'from'));

ALTER TABLE escalation_logs DISABLE ROW LEVEL SECURITY;

-- Vérification
SELECT id, data->>'from' AS client, data->>'status' AS status,
       created_at, updated_at
FROM escalation_logs
ORDER BY created_at DESC
LIMIT 20;
