# Correction paniers et escalades

Cette version part du projet `sekhmet-corrige-v9-escalades-persistantes`.

## Panier

Le projet ne possédait pas de table `carts` dédiée. Les sélections étaient uniquement stockées dans `payment_state` / `payment_states`.

La correction ajoute désormais une vraie persistance de panier :
- SQLite : table `carts` dans `data/sqlite.db.js`.
- Supabase : table `carts` dans `supabase_schema.sql` et `supabase_cart_escalation_update.sql`.
- Le panier est alimenté à chaque sélection de produit.
- Les quantités d'un même produit sont regroupées lors de la lecture du panier.
- Le panier est vidé après création de la commande confirmée ou lors d'un abandon explicite.
- `GET /api/paniers` continue de fournir les paniers actifs à l'administration.

Le champ `selections` de `payment_state` reste conservé pour compatibilité avec le cycle de paiement existant. Le panier dédié devient la source persistante des sélections avant paiement.

## Escalades

La configuration existante des numéros reste stockée dans `bot_settings` en mode Supabase ou dans `settings` en SQLite.

Chaque numéro peut avoir :
- un libellé ;
- une priorité ;
- une plage horaire ;
- un état activé/désactivé.

Le service choisit les numéros actifs pour l'heure courante et les trie par priorité. Si le premier contact n'est pas joignable, la tentative suivante utilise le contact suivant. Si le premier est joignable mais ne répond pas, la relance est effectuée après `timeoutMinutes`.

Les tentatives sont persistées dans `escalation_logs`, ce qui permet de restaurer les escalades en attente après un redémarrage.

## Point important WhatsApp / Meta

Une escalade peut être correctement créée dans l'application tout en échouant au moment de contacter un numéro. La raison peut être liée aux règles de messagerie initiée par l'entreprise de WhatsApp Business : un simple message texte n'est pas toujours autorisé lorsque le destinataire n'a pas une fenêtre de conversation ouverte avec le compte WhatsApp Business.

Le code remonte désormais l'erreur Meta dans les logs d'escalade au lieu de considérer l'envoi comme réussi. Pour une notification d'escalade réellement fiable vers des numéros qui n'ont pas ouvert de conversation, il faut prévoir un template WhatsApp approuvé par Meta et l'utiliser pour la notification d'entreprise.

## Migration Supabase

Exécuter `supabase_cart_escalation_update.sql` dans le SQL Editor Supabase pour une base existante. Le script est non destructif et crée les tables manquantes sans supprimer les données existantes.
