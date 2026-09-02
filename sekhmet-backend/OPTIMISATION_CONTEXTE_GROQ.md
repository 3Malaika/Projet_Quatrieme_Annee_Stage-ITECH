# Optimisation du contexte envoyé à Groq

Cette version conserve l'historique complet pour l'administration, mais ne transmet plus automatiquement toute la conversation ni le catalogue complet aux appels Groq.

## Nouveau comportement

- Le message actuel reste la donnée principale.
- Jusqu'à 4 messages récents maximum sont conservés comme contexte conversationnel.
- Chaque ancien message envoyé à Groq est limité à 450 caractères.
- Le nom et le besoin du client sont transmis séparément sous forme structurée.
- Le panier est transmis sous forme d'une courte liste structurée (produit + quantité), uniquement pour aider Groq lorsque nécessaire.
- Les procédures sont sélectionnées par pertinence à partir de la question et limitées à environ 2800 caractères.
- Le catalogue complet, les bienfaits complets et les anciennes instructions système ne sont plus envoyés systématiquement à Groq.
- Le catalogue reste accessible via les outils prévus pour les fiches, recommandations et ajout au panier.
- L'historique complet reste conservé dans SQLite/Supabase pour l'interface d'administration.
- L'extraction du nom et du besoin utilise également un contexte minimal au lieu de renvoyer toute la conversation.
- Le résumé d'escalade est limité aux 12 derniers messages et à 500 caractères par message.

## Objectif

Réduire fortement les tokens d'entrée par appel Groq, améliorer la latence et éviter qu'une conversation longue fasse exploser la consommation tout en conservant les règles métier nécessaires à la réponse.
