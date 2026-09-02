-- ============================================================
-- SEKHMET - UNE SEULE ESCALADE ACTIVE PAR NUMÉRO CLIENT
--
-- À exécuter une seule fois dans Supabase > SQL Editor.
-- La contrainte empêche deux escalades "en_attente" pour le même
-- numéro client, même en cas de requêtes concurrentes ou de plusieurs
-- instances du backend.
-- ============================================================

-- Si des doublons actifs existent déjà, on conserve l'escalade la plus
-- récente et clôture les anciennes avant de créer l'index unique.
WITH actifs AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY data->>'from'
      ORDER BY created_at DESC, id DESC
    ) AS rang
  FROM escalation_logs
  WHERE data->>'status' = 'en_attente'
), doublons AS (
  SELECT id FROM actifs WHERE rang > 1
)
UPDATE escalation_logs e
SET
  data = jsonb_set(
    jsonb_set(
      e.data,
      '{status}',
      '"cloturee"'::jsonb,
      true
    ),
    '{closedAt}',
    to_jsonb(now()),
    true
  ),
  updated_at = now()
WHERE e.id IN (SELECT id FROM doublons);

CREATE UNIQUE INDEX IF NOT EXISTS uq_escalation_one_pending_per_phone
  ON escalation_logs ((data->>'from'))
  WHERE data->>'status' = 'en_attente';

-- Vérification : cette requête ne doit retourner aucune ligne.
SELECT data->>'from' AS client, COUNT(*) AS escalades_actives
FROM escalation_logs
WHERE data->>'status' = 'en_attente'
GROUP BY data->>'from'
HAVING COUNT(*) > 1;
