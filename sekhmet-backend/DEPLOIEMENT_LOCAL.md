# Déploiement local / serveur interne

## Prérequis

- Node.js 22.5 ou plus récent
- Apache est optionnel : il peut servir le frontend construit et faire reverse-proxy vers Node.

## Backend

```bash
cd backend
npm install
npm start
```

Le backend utilise SQLite par défaut et crée `data/sekhmet.sqlite` au premier démarrage.

## Frontend

```bash
cd frontend
npm install
npm run build
```

Le dossier `frontend/dist` peut être servi directement par Apache.

## Images

Les photos sont dans `backend/uploads/produits/` et sont servies par Express sous `/uploads/produits/...`.

Pour un serveur dont l'adresse est connue :

```env
PUBLIC_BASE_URL=http://192.168.1.20:3000
```

## Sauvegardes

La base SQLite est un fichier. Sauvegarde recommandée :

```bash
cd backend
npm run backup
```

Sauvegarder également `uploads/`.

## Architecture recommandée avec Apache

Apache sert le frontend et peut rediriger `/api` et `/webhook` vers le processus Node/Express. Le backend n'a pas besoin d'être exposé directement sur Internet si Apache est le point d'entrée.
