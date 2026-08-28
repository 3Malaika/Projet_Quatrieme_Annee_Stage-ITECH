
-- ============================================================
-- 6. COMMANDES / FACTURES
-- Ajouté pour la génération automatique de facture après paiement.
-- ============================================================
CREATE TABLE IF NOT EXISTS commandes (
  id                  TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  phone               TEXT        NOT NULL,
  nom_client          TEXT,
  produits            TEXT        NOT NULL,   -- description libre saisie par le collaborateur
  montant_total       NUMERIC     NOT NULL,
  compte_mobile_money TEXT,
  delai_livraison     TEXT,
  statut              TEXT        NOT NULL DEFAULT 'paiement_confirme', -- paiement_confirme | facturee
  numero_facture      TEXT        UNIQUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE commandes DISABLE ROW LEVEL SECURITY;

-- Si la table commandes existait déjà avec l'ancien défaut (epoch en
-- secondes, collisions possibles), exécuter cette ligne pour corriger :
-- ALTER TABLE commandes ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;

-- ============================================================
-- 7. CONSOMMATION DE TOKENS GROQ
-- Ajouté pour suivre la consommation réelle (logs + dashboard admin),
-- notamment après la fusion classifyMessage()+askGroq() en un seul appel.
-- ============================================================
CREATE TABLE IF NOT EXISTS token_usage (
  id                TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  type              TEXT        NOT NULL,  -- reponse | extraction_client | extraction_paiement | resume_escalade
  model             TEXT        NOT NULL,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  total_tokens      INTEGER,
  phone             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_token_usage_created_at ON token_usage (created_at DESC);

ALTER TABLE token_usage DISABLE ROW LEVEL SECURITY;

-- ============================================================
-- 8. LOGS IMPORTANTS (Groq / Meta / Système)
-- Ajouté pour remonter au dashboard admin, en version simplifiée, les
-- erreurs les plus importantes (échec appel Groq, échec envoi
-- WhatsApp/Meta, etc.) sans avoir à fouiller les logs Render.
-- ============================================================
CREATE TABLE IF NOT EXISTS system_logs (
  id         TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  level      TEXT        NOT NULL,   -- "error" (seul niveau capturé pour l'instant)
  source     TEXT        NOT NULL,   -- groq | meta | systeme
  context    TEXT        NOT NULL,   -- module d'origine (chat, whatsapp, webhook...)
  message    TEXT        NOT NULL,
  detail     TEXT,                   -- message d'erreur / extrait, tronqué à 300 caractères
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_system_logs_created_at ON system_logs (created_at DESC);

ALTER TABLE system_logs DISABLE ROW LEVEL SECURITY;

-- ============================================================
-- 9. QUANTITÉ EN STOCK
-- Ajouté pour saisir une quantité numérique en plus du statut
-- disponible/rupture existant (qui reste inchangé et continue de piloter
-- la disponibilité affichée au client sur WhatsApp).
-- ============================================================
ALTER TABLE produits ADD COLUMN IF NOT EXISTS quantite INTEGER NOT NULL DEFAULT 0;
