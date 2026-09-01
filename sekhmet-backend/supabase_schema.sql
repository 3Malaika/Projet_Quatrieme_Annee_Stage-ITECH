
-- ============================================================
-- 6. COMMANDES / FACTURES
-- Ajouté pour la génération automatique de facture après paiement.
-- ============================================================
CREATE TABLE IF NOT EXISTS commandes (
  id                  TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  phone               TEXT        NOT NULL,
  nom_client          TEXT,
  produits            TEXT        NOT NULL,   -- description lisible (auto-générée depuis produits_detail si possible, sinon saisie par le collaborateur)
  produits_detail      TEXT,                   -- JSON structuré des choix de quantité du client : [{produitId, nom, quantite, prixUnitaire, total}]
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

-- Si la table commandes existait déjà AVANT l'ajout de la persistance
-- structurée des choix de quantité, exécuter cette ligne pour ajouter la
-- colonne manquante :
-- ALTER TABLE commandes ADD COLUMN IF NOT EXISTS produits_detail TEXT;

-- ============================================================
-- PANIER PERSISTANT
-- Le panier est distinct de l'état de paiement : il existe dès qu'un
-- client sélectionne un ou plusieurs produits et peut être consulté par
-- l'administration avant tout paiement.
-- ============================================================
CREATE TABLE IF NOT EXISTS carts (
  phone       TEXT PRIMARY KEY,
  items       JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_carts_updated_at ON carts (updated_at DESC);
ALTER TABLE carts DISABLE ROW LEVEL SECURITY;

-- ============================================================
-- 8. ÉTAT TRANSITOIRE DU CYCLE DE PAIEMENT (persistant)
-- Avant cette table, l'état "en cours" (paiement en attente de
-- vérification, commande payée en attente de délai de livraison,
-- quantité choisie par le client en attente de paiement) vivait
-- uniquement en mémoire côté serveur (payment.service.js) et était perdu
-- à chaque redémarrage/crash — risque de "perdre" une commande en cours.
-- Une ligne par client (phone = clé), mise à jour à chaque étape du cycle.
-- ============================================================
CREATE TABLE IF NOT EXISTS payment_state (
  phone                       TEXT        PRIMARY KEY,
  pending_payment             JSONB,      -- { userMessage, compteMobileMoney, timestamp } | null
  awaiting_delai_commande_id  TEXT,       -- id de la commande payée en attente de délai | null
  selections                  JSONB       NOT NULL DEFAULT '[]', -- [{ produitId, nom, quantite, prixUnitaire, total, timestamp }]
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE payment_state DISABLE ROW LEVEL SECURITY;

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

-- ============================================================
-- INDEX ANALYTICS ACHATS / DASHBOARD
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_commandes_created_at ON commandes (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commandes_statut_created_at ON commandes (statut, created_at DESC);


-- ============================================================
-- CONFIGURATION DU PARCOURS ET DES ESCALADES
-- ============================================================
CREATE TABLE IF NOT EXISTS bot_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE bot_settings DISABLE ROW LEVEL SECURITY;

-- ============================================================
-- 10. PERSISTANCE DES ESCALADES
-- Les escalades étaient auparavant conservées uniquement en mémoire du
-- processus Node.js. Cette table permet de conserver l'historique, les
-- destinataires, les tentatives d'envoi et les erreurs Meta, et de reprendre
-- une escalade encore en attente après un redémarrage du serveur.
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
