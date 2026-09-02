# Persistance de la consommation Groq

La consommation n'est pas recalculée par Sekhmet. Pour chaque appel Groq, le backend lit directement `response.usage` :

- `prompt_tokens`
- `completion_tokens`
- `total_tokens`

Chaque appel est enregistré dans `public.token_usage` lorsque le backend utilise Supabase. Le dashboard additionne ensuite progressivement les `total_tokens` enregistrés.

`recordUsage()` est maintenant `async` et est attendu (`await`) après chaque appel Groq. L'écriture n'est donc plus lancée en arrière-plan. Une erreur de persistance est signalée dans les logs mais ne fait pas échouer la réponse WhatsApp.

En production Render, vérifier :

```env
STORAGE_MODE=supabase
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=...
```

Et exécuter une fois `supabase_dashboard_migration.sql` dans Supabase SQL Editor pour créer `public.token_usage` si nécessaire.
