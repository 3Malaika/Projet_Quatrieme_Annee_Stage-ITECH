# Stockage local de Sekhmet

Le mode local recommandé est maintenant **SQLite**.

- Base de données : `data/sekhmet.sqlite`
- Photos produits : `uploads/produits/`
- Aucun service cloud n'est nécessaire pour le catalogue, les clients, les commandes, les conversations, les paiements, les journaux ou la consommation Groq.
- Les anciens JSON/TXT présents à la racine sont conservés comme sauvegarde et sont migrés automatiquement au premier démarrage d'une base SQLite vide.

## Configuration

```env
STORAGE_MODE=sqlite
DATA_DIR=./data
SQLITE_DB_PATH=./data/sekhmet.sqlite
UPLOAD_DIR=./uploads/produits
PUBLIC_BASE_URL=http://localhost:3000
```

Supabase reste disponible uniquement en mode explicite :

```env
STORAGE_MODE=supabase
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=...
```

## Sauvegarde

La base SQLite peut être copiée comme un fichier normal. Pour une sauvegarde via le projet :

```bash
npm run backup
```
