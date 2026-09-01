-- Mise à jour minimale pour les versions existantes de Sekhmet.
-- À exécuter dans Supabase SQL Editor. Script non destructif.

CREATE TABLE IF NOT EXISTS carts (
  phone       TEXT PRIMARY KEY,
  items       JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_carts_updated_at ON carts (updated_at DESC);
ALTER TABLE carts DISABLE ROW LEVEL SECURITY;

-- Vérifie aussi les tables nécessaires aux escalades persistantes.
CREATE TABLE IF NOT EXISTS bot_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS escalation_logs (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_escalation_logs_created_at ON escalation_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_escalation_logs_status ON escalation_logs((data->>'status'));
CREATE INDEX IF NOT EXISTS idx_escalation_logs_from ON escalation_logs((data->>'from'));
ALTER TABLE escalation_logs DISABLE ROW LEVEL SECURITY;

-- Si payment_state manque encore :
CREATE TABLE IF NOT EXISTS payment_state (
  phone TEXT PRIMARY KEY,
  pending_payment JSONB,
  awaiting_delai_commande_id TEXT,
  selections JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE payment_state DISABLE ROW LEVEL SECURITY;
