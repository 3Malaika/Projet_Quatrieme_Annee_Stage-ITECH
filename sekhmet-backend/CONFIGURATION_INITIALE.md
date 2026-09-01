# Configuration initiale Sekhmet

Le backend expose désormais une vérification persistante de la configuration d’administration.

## Vérifier l’état
`GET /api/configuration/status`

La réponse indique notamment `configured`, `hasPaymentAccount` et `hasEscalationNumber`.

## Enregistrer la première configuration
`PUT /api/configuration/initial`

Le payload doit contenir `paymentAccounts` et une configuration avec au moins un numéro d’escalade. Après succès, le backend marque `setup.completed=true`.

Les ouvertures suivantes doivent appeler `/status` avant d’afficher l’assistant : si `configured=true`, ouvrir directement l’application normale. Les pages de configuration ordinaires restent utilisables ensuite via `GET/PUT /api/configuration` et `/api/paiement-compte`.

La configuration est persistante dans SQLite ou Supabase selon le mode de stockage du backend.
