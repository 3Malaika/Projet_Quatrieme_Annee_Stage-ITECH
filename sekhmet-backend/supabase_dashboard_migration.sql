-- À exécuter une seule fois dans Supabase > SQL Editor.
-- Cette migration active le suivi réel de consommation IA du dashboard.

CREATE TABLE IF NOT EXISTS public.token_usage (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  type TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  phone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_token_usage_created_at
  ON public.token_usage (created_at DESC);

ALTER TABLE public.token_usage DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.produits
  ADD COLUMN IF NOT EXISTS quantite INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_commandes_created_at
  ON public.commandes (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_commandes_statut_created_at
  ON public.commandes (statut, created_at DESC);
