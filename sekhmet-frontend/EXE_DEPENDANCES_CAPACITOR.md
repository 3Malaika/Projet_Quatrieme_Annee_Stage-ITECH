# EXE Windows — séparation des dépendances Capacitor

Le build Windows Electron ne télécharge plus les plugins Capacitor.

- Le workflow `.github/workflows/build-exe.yml` utilise `npm ci`.
- Il ne lance plus `npm install` des plugins Capacitor.
- Les dépendances Capacitor ont été retirées des dépendances de production du frontend.
- Les imports Capacitor sont chargés uniquement à l'exécution sur une plateforme native, avec des imports dynamiques ignorés par Vite.
- Electron utilise donc le fallback web/localStorage et n'a pas besoin des modules Capacitor.

Pour Android, les plugins Capacitor doivent être installés dans l'environnement Android avant `cap sync`/Gradle. Ils ne font pas partie du build Electron.
