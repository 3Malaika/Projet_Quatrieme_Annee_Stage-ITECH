-- ============================================================
-- Sekhmet Shop Backend — Schéma Supabase
-- À exécuter dans : Supabase Dashboard > SQL Editor > New query
-- ============================================================

-- 1. CATALOGUE DES PRODUITS
-- Remplace catalogue.json
CREATE TABLE IF NOT EXISTS produits (
  id          TEXT        PRIMARY KEY DEFAULT (extract(epoch from now())::bigint::text),
  nom         TEXT        NOT NULL,
  unite       TEXT        NOT NULL DEFAULT '',
  prix        TEXT        NOT NULL,
  stock       TEXT        NOT NULL DEFAULT 'disponible',
  categorie   TEXT        NOT NULL DEFAULT 'autres',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. CLIENTS IDENTIFIÉS
-- Remplace clients.json
-- besoins : tableau JSONB ex: ["formation", "suivi alimentaire"]
-- contacts_at : tableau JSONB des dates de contact, index aligné sur besoins
CREATE TABLE IF NOT EXISTS clients (
  phone        TEXT        PRIMARY KEY,
  client_id    TEXT        UNIQUE,
  nom          TEXT,
  besoins      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  contacts_at  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Trigger pour mettre à jour updated_at automatiquement
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER clients_updated_at
  BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 3. CONVERSATIONS WHATSAPP
-- Remplace conversations.json
-- Les messages sont stockés en JSONB (tableau [{role, content}])
CREATE TABLE IF NOT EXISTS conversations (
  phone       TEXT        PRIMARY KEY,
  messages    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. TEXTES DE CONFIGURATION
-- Remplace bienfaits.txt, procedures.txt, message_ouverture.txt
CREATE TABLE IF NOT EXISTS config_textes (
  cle         TEXT        PRIMARY KEY,  -- 'bienfaits' | 'procedures' | 'message_ouverture'
  contenu     TEXT        NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Valeurs par défaut
INSERT INTO config_textes (cle, contenu) VALUES
  ('bienfaits',          ''),
  ('procedures',         'Aucune procédure spécifique enregistrée.'),
  ('message_ouverture',  'Bonjour 👋 et merci de nous avoir contactés ! Un conseiller va prendre en charge votre demande.')
ON CONFLICT (cle) DO NOTHING;

-- 5. CATEGORIES
-- Remplace categories.json
CREATE TABLE IF NOT EXISTS categories (
  name        TEXT        PRIMARY KEY,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Catégories par défaut
INSERT INTO categories (name) VALUES
  ('poudres'), ('farines'), ('sels'), ('graines'), ('grignotages'),
  ('assaisonnements'), ('produits_sales'), ('laitiers_boissons'),
  ('patisseries'), ('boissons_naturelles'), ('packs_amincissant'),
  ('pains'), ('suivi'), ('livraisons'), ('autres')
ON CONFLICT (name) DO NOTHING;

-- ============================================================
-- SÉCURITÉ : Row Level Security
-- Le backend Node.js utilise la clé SERVICE_ROLE (accès total).
-- Désactiver RLS pour simplifier ou configurer selon vos besoins.
-- ============================================================
ALTER TABLE produits       DISABLE ROW LEVEL SECURITY;
ALTER TABLE clients        DISABLE ROW LEVEL SECURITY;
ALTER TABLE conversations  DISABLE ROW LEVEL SECURITY;
ALTER TABLE config_textes  DISABLE ROW LEVEL SECURITY;
ALTER TABLE categories     DISABLE ROW LEVEL SECURITY;
