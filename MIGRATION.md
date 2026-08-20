# Guide de migration — Sekhmet Shop Backend

Ce document explique comment basculer la persistance des données du stockage fichier JSON (actuel, utilisé sur Render) vers une base de données persistante, et comment migrer l'hébergement du backend vers l'infrastructure de l'entreprise.

> **Note importante** : Supabase est utilisé comme solution de transition gratuite. La cible finale est le **serveur de l'entreprise** avec une base PostgreSQL interne. Le code est conçu pour fonctionner dans les deux cas sans modification — seules les variables d'environnement changent.

---

## État actuel

| Composant | Hébergement actuel | Cible entreprise |
|---|---|---|
| Backend Node.js | Render (gratuit) | Serveur interne entreprise |
| Base de données | Fichiers JSON (éphémères) | PostgreSQL interne |
| Frontend APK | GitHub Actions | GitHub Actions (inchangé) |
| Frontend EXE | GitHub Actions | GitHub Actions (inchangé) |

---

## Étape 1 — Créer la base de données

### Option A — Supabase (transition)
1. Aller sur [supabase.com](https://supabase.com) et créer un compte
2. Créer un nouveau projet
3. Récupérer depuis **Project Settings > API** :
   - `Project URL` → `SUPABASE_URL`
   - Clé `service_role` → `SUPABASE_SERVICE_KEY`

### Option B — PostgreSQL interne (cible finale entreprise)
1. Installer PostgreSQL sur le serveur de l'entreprise
2. Créer une base dédiée : `createdb sekhmet_shop`
3. Les variables d'environnement à définir :
   - `SUPABASE_URL` → URL de connexion PostgreSQL (ex: `postgresql://user:pass@host:5432/sekhmet_shop`)
   - `SUPABASE_SERVICE_KEY` → mot de passe ou clé de service

> Le code utilise le SDK `@supabase/supabase-js` qui peut se connecter à n'importe quelle instance PostgreSQL compatible.

---

## Étape 2 — Créer les tables ✅ (script prêt)

Exécuter le script SQL dans votre outil de gestion de base de données (Supabase SQL Editor, pgAdmin, psql...) :

```bash
# Via psql
psql -U postgres -d sekhmet_shop -f sekhmet-backend/supabase_schema.sql
```

Ou copier-coller le contenu de `sekhmet-backend/supabase_schema.sql` dans l'éditeur SQL.

Tables créées :
| Table | Remplace |
|---|---|
| `produits` | `catalogue.json` |
| `clients` | `clients.json` |
| `conversations` | `conversations.json` |
| `config_textes` | `bienfaits.txt`, `procedures.txt`, `message_ouverture.txt` |

---

## Étape 3 — Installer le SDK Supabase

```bash
cd sekhmet-backend
npm install @supabase/supabase-js
```

---

## Étape 4 — Configurer les variables d'environnement

### Sur Render (ou serveur entreprise)
Ajouter ces deux variables dans l'environnement :
```
SUPABASE_URL=https://xxxx.supabase.co          # ou URL PostgreSQL interne
SUPABASE_SERVICE_KEY=eyJ...                     # clé service_role ou mot de passe DB
```

### En local (développement)
Dans `sekhmet-backend/.env` :
```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
```

> Si ces variables sont absentes, le backend continue de fonctionner avec les fichiers JSON — aucune modification de code nécessaire.

---

## Étape 5 — Basculer les routes ✅ (déjà réalisé)

Toutes les routes et le service de chat ont été mis à jour. La bascule est **automatique** :
- Si `SUPABASE_URL` est défini → utilise les stores Supabase
- Sinon → utilise les fichiers JSON

Fichiers modifiés :
- `routes/produits.routes.js`
- `routes/clients.routes.js`
- `routes/bienfaits.routes.js`
- `routes/procedures.routes.js`
- `routes/messageOuverture.routes.js`
- `routes/conversations.routes.js`
- `services/chat.service.js`

---

## Étape 6 — Rendre les routes async ✅ (déjà réalisé)

Toutes les routes sont désormais `async/await`. Aucune action requise.

---

## Étape 7 — Migrer les données existantes ✅ (script prêt)

Un script de migration `sekhmet-backend/migrate.js` est prêt à l'emploi.

### Exécution

```bash
cd sekhmet-backend
node migrate.js
```

Le script migre dans l'ordre :
1. `catalogue.json` → table `produits`
2. `clients.json` → table `clients`
3. `conversations.json` → table `conversations`
4. `bienfaits.txt`, `procedures.txt`, `message_ouverture.txt` → table `config_textes`

Il est idempotent (peut être relancé sans risque de doublons grâce aux `upsert`).

---

## Migration de l'hébergement vers le serveur entreprise

### Prérequis serveur
- Node.js 22+
- PostgreSQL 14+ (ou accès à une instance existante)
- Reverse proxy HTTPS (Nginx recommandé) — **obligatoire** pour les webhooks WhatsApp

### Déploiement

```bash
# 1. Cloner le repo
git clone https://github.com/3Malaika/Projet_Quatrieme_Annee_Stage-ITECH.git
cd Projet_Quatrieme_Annee_Stage-ITECH/sekhmet-backend

# 2. Installer les dépendances
npm install

# 3. Créer le fichier .env (voir .env.example)
cp .env.example .env
# Remplir toutes les valeurs dans .env

# 4. Créer les tables (une seule fois)
psql -U postgres -d sekhmet_shop -f supabase_schema.sql

# 5. Migrer les données existantes (une seule fois)
node migrate.js

# 6. Lancer avec PM2
npm install -g pm2
pm2 start server.js --name sekhmet-backend
pm2 save
pm2 startup
```

### Configuration Nginx (reverse proxy HTTPS)

```nginx
server {
    listen 443 ssl;
    server_name api.votre-domaine.com;

    ssl_certificate     /etc/letsencrypt/live/api.votre-domaine.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.votre-domaine.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Obtenir le certificat SSL avec Certbot :
```bash
certbot --nginx -d api.votre-domaine.com
```

### Après migration : mettre à jour les pointeurs

1. **Webhook WhatsApp** → Meta for Developers → mettre à jour l'URL vers `https://api.votre-domaine.com/webhook`
2. **Secret GitHub `VITE_API_BASE_URL`** → mettre la nouvelle URL
3. **Regénérer APK et EXE** → Actions GitHub → Build APK + Build EXE

### Variables d'environnement complètes
```
PORT=3000
GROQ_API_KEY=
VERIFY_TOKEN=
WHATSAPP_TOKEN=
PHONE_NUMBER_ID=
HUMAN_AGENT_NUMBER=
ADMIN_TOKEN=
SUPABASE_URL=postgresql://user:password@localhost:5432/sekhmet_shop
SUPABASE_SERVICE_KEY=mot_de_passe_ou_cle_service
```

---

## Résumé des fichiers clés

| Fichier | Rôle | État |
|---|---|---|
| `supabase_schema.sql` | Script SQL de création des tables | ✅ Prêt |
| `migrate.js` | Script de migration JSON → DB | ✅ Prêt |
| `data/supabase.client.js` | Client Supabase partagé | ✅ Prêt |
| `data/catalogue.store.supabase.js` | Store produits | ✅ Prêt |
| `data/clients.store.supabase.js` | Store clients | ✅ Prêt |
| `data/conversations.store.supabase.js` | Store conversations | ✅ Prêt |
| `data/configTextes.store.supabase.js` | Store bienfaits/procédures/message | ✅ Prêt |
| `routes/produits.routes.js` | Route produits async | ✅ Migré |
| `routes/clients.routes.js` | Route clients async | ✅ Migré |
| `routes/bienfaits.routes.js` | Route bienfaits async | ✅ Migré |
| `routes/procedures.routes.js` | Route procédures async | ✅ Migré |
| `routes/messageOuverture.routes.js` | Route message d'ouverture async | ✅ Migré |
| `routes/conversations.routes.js` | Route conversations async | ✅ Migré |
| `services/chat.service.js` | Service chat avec stores dynamiques | ✅ Migré |
| `config/env.js` | Config (inclut SUPABASE_URL/KEY) | ✅ Mis à jour |
| `.env.example` | Template variables d'environnement | ✅ Mis à jour |
