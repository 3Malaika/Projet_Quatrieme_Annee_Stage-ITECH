# Chatbot hybride : moteur local d'intention + moteur métier + Groq

## Architecture retenue

Le chatbot suit désormais trois niveaux, dans cet ordre :

1. **Règles locales** : normalisation, expressions connues, extraction du nom et du besoin, paiements, procédures explicites.
2. **Petit modèle NLP local** : `TF-IDF + similarité cosinus (classifieur local léger)`, exécuté avec Transformers.js en ONNX quantifié (`q8`). Il sert à comparer sémantiquement le message du client aux exemples d'intentions. Il ne génère aucune réponse.
3. **Groq** : uniquement lorsque l'intention n'est pas suffisamment certaine ou lorsque la conversation nécessite une formulation libre/complexe.

Le moteur local est chargé à la demande puis conservé en mémoire. Il est téléchargé depuis Hugging Face au premier démarrage qui nécessite une analyse sémantique ; les démarrages suivants réutilisent le cache disponible sur la machine.

## Pourquoi ce modèle

Le modèle est multilingue, de type sentence-transformer, avec une représentation de 384 dimensions. Son dépôt ONNX est prévu pour Transformers.js et peut être utilisé directement avec `pipeline('feature-extraction', ...)`.

Référence : https://huggingface.co/TF-IDF + similarité cosinus (classifieur local léger)

## Données administrables

Le moteur recharge à chaque analyse les contenus configurés dans les ressources :

- **Message d'accueil** : le premier message envoyé au client reste le texte exact configuré dans l'administration ; il n'est pas reformulé par le moteur local ni par Groq.
- **Procédures** : elles restent la source de vérité pour les règles métier et les catégories d'escalade. Le moteur local ne crée pas de nouvelle règle d'escalade qui ne serait pas explicitement prévue.
- **Bienfaits** : ils alimentent les recommandations locales lorsque les associations sont suffisamment claires.

Ces données viennent de SQLite en local ou de Supabase lorsque `STORAGE_MODE=supabase`.

## Seuils de sécurité

Le moteur local n'est pas autorisé à décider d'une action métier sensible sur une simple ressemblance faible. Une confiance insuffisante laisse passer le message à Groq.

Les paiements et les escalades restent soumis aux règles explicites des procédures.

## Installation

Dans `backend` :

```bash
npm install
```

La dépendance ajoutée est :

```text
(aucune dépendance native de type Transformers.js) ^3.8.1
```

Au premier message nécessitant l'analyse sémantique, le modèle peut être téléchargé depuis Hugging Face. Il faut donc une connexion Internet lors du premier chargement en production.

## Render + Supabase

Le moteur local ne remplace pas Supabase. Sur Render, la configuration recommandée reste :

```env
STORAGE_MODE=supabase
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=...
```

Supabase conserve PostgreSQL, les conversations, les ressources, les produits et les autres données persistantes. Le petit modèle NLP tourne simplement dans le processus Node.js de Render.

Le projet n'embarque pas les poids du modèle dans le ZIP : cela évite d'alourdir inutilement le dépôt. Le premier démarrage télécharge le modèle depuis Hugging Face.

## Test rapide

Tester notamment :

- `Bonjour`
- `Coucou 😊`
- `Je voulais juste vous dire bonjour`
- `Je voudrais voir tous vos produits`
- `Comment je peux payer ?`
- `J'ai déjà envoyé l'argent`
- `Vous avez encore ce produit ?`
- `Je cherche un petit cadeau naturel pour ma mère`
- une demande volontairement ambiguë ou très libre

Les premières demandes simples doivent être traitées localement. La dernière catégorie doit normalement passer à Groq si le score local n'est pas suffisamment sûr.


## Sécurité des dépendances
La version actuelle ne dépend plus de `@huggingface/transformers` et de `sharp`. Le moteur local est volontairement sans dépendance native afin d’éviter la chaîne de vulnérabilités signalée par `npm audit`.
