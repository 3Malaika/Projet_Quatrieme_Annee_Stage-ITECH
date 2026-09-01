# Modèle NLP local

Sekhmet utilise un petit moteur local uniquement pour comprendre/classer les intentions :

**TF-IDF + similarité cosinus (classifieur local léger)**

Il est exécuté par **(aucune dépendance native de type Transformers.js)** avec la tâche `feature-extraction` et un poids ONNX quantifié `q8`.

Il ne génère pas de texte et ne remplace pas Groq. Son rôle est de répondre à :

> « À quelle intention connue ce message ressemble-t-il le plus ? »

Le moteur combine ensuite :

- score des règles explicites ;
- score sémantique du modèle ;
- contexte client ;
- données des ressources ;
- procédures métier.

Si la confiance n'est pas suffisante, le message est laissé à Groq.


## Sécurité des dépendances
La version actuelle ne dépend plus de `@huggingface/transformers` et de `sharp`. Le moteur local est volontairement sans dépendance native afin d’éviter la chaîne de vulnérabilités signalée par `npm audit`.
