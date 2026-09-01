# Tests NLP par CSV

Le fichier `questions.csv` est un modèle que tu peux modifier ou remplacer.

Format minimal :

```csv
intent,question
greeting,"Bonjour"
price,"Vous le faites à combien ?"
stock,"Vous en avez encore ?"
```

- `intent` = intention attendue
- `question` = message à analyser

Tu peux ajouter autant de lignes que nécessaire. Les questions contenant des virgules doivent être entourées de guillemets.

## Lancer le test

Depuis le dossier backend :

```bash
npm run test:nlp:csv
```

Pour utiliser un autre fichier :

```bash
npm run test:nlp:csv -- ./tests/mes-questions.csv
```

Le rapport indique pour chaque ligne : intention attendue, intention détectée, confiance, marge entre les deux meilleures intentions et décision LOCAL/GROQ.
