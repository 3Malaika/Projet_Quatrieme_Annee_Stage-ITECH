
-- ============================================================
-- 6. COMMANDES / FACTURES
-- Ajouté pour la génération automatique de facture après paiement.
-- ============================================================
CREATE TABLE IF NOT EXISTS commandes (
  id                  TEXT        PRIMARY KEY DEFAULT (extract(epoch from now())::bigint::text),
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
