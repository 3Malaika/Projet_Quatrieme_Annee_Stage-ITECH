# Pourquoi le .exe Electron est beaucoup plus gros que l APK

L APK Android utilise principalement le WebView Android déjà présent sur l appareil. Il peut donc rester relativement léger.

Le .exe Electron embarque son propre runtime Chromium + Node.js, ainsi que les fichiers de l application. C est normal qu il soit nettement plus lourd.

Une cause supplémentaire dans l ancienne configuration était la règle `node_modules/**/*` dans electron-builder : elle forçait l inclusion de tout le dossier node_modules dans le package. Cette règle a été supprimée. electron-builder ne doit conserver que les dépendances de production réellement nécessaires.

Cela réduit fortement la taille de l installateur, sans supprimer Chromium/Node.js qui sont nécessaires à une application Electron autonome.
