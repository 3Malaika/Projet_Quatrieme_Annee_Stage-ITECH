# Moteur NLP local

Le chatbot utilise un moteur local léger, sans modèle LLM à télécharger :

1. normalisation du français (accents, casse, abréviations WhatsApp courantes) ;
2. NLP lexical léger (stopwords, racines simples, bigrammes et tolérance aux petites fautes) ;
3. règles explicites pour les intentions sensibles ou faciles à reconnaître ;
4. TF-IDF + similarité cosinus pour généraliser aux formulations proches ;
5. extraction locale de quelques entités (nom, besoin, quantité, budget, téléphone, moyen de paiement) ;
6. score de confiance + marge avec la deuxième intention ;
7. transfert à Groq lorsque la confiance est insuffisante ou que plusieurs intentions sont plausibles.

Le moteur ne prétend pas comprendre comme un LLM. Il sert à économiser des appels Groq sur les messages évidents et à détecter les cas où il vaut mieux laisser Groq utiliser le contexte complet de la conversation.

## Test automatique

```bash
npm run test:nlp
```

## Test interactif

```bash
npm run test:nlp:interactive
```

Écrivez une phrase, puis Entrée. Le programme affiche l'intention, la confiance, la marge, la décision LOCAL/GROQ, les entités et les scores.
