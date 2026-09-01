# Stockage SQLite

Sekhmet utilise SQLite par défaut. La base est un seul fichier : `data/sekhmet.sqlite`.
Les photos restent dans `uploads/produits/`.

## Démarrage

Node.js 22.5+ est requis car le backend utilise `node:sqlite`.

```bash
npm install
npm start
```

Le premier démarrage migre automatiquement les anciens fichiers JSON/TXT présents à la racine du backend vers SQLite. Les fichiers sources sont conservés comme sauvegarde et ne sont plus utilisés ensuite.

## Configuration

```env
STORAGE_MODE=sqlite
DATA_DIR=./data
SQLITE_DB_PATH=./data/sekhmet.sqlite
UPLOAD_DIR=./uploads/produits
PUBLIC_BASE_URL=http://localhost:3000
```

Supabase reste disponible en choisissant explicitement `STORAGE_MODE=supabase`.

## Sauvegarde

```bash
npm run backup
```

Une copie datée de la base est créée dans `backups/`.
