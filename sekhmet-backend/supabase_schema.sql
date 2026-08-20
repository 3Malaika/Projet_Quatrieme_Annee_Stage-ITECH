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
CREATE TABLE IF NOT EXISTS clients (
  phone       TEXT        PRIMARY KEY,
  nom         TEXT,
  besoin      TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

-- ============================================================
-- SÉCURITÉ : Row Level Security
-- Le backend Node.js utilise la clé SERVICE_ROLE (accès total).
-- Désactiver RLS pour simplifier ou configurer selon vos besoins.
-- ============================================================
ALTER TABLE produits       DISABLE ROW LEVEL SECURITY;
ALTER TABLE clients        DISABLE ROW LEVEL SECURITY;
ALTER TABLE conversations  DISABLE ROW LEVEL SECURITY;
ALTER TABLE config_textes  DISABLE ROW LEVEL SECURITY;
