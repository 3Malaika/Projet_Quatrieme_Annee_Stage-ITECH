const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");
// electron-serve v2+ est un module ESM pur (export default). Quand on le
// charge via require() depuis ce fichier CommonJS, l'interop Node renvoie
// { default: fn } et non fn directement — d'où "serve is not a function"
// si on utilisait le require() brut. On gère les deux cas (v1 CJS et v2/3 ESM)
// pour ne pas dépendre d'une version précise du package.
const serveModule = require("electron-serve");
const serve = typeof serveModule === "function" ? serveModule : serveModule.default;

// Le build Vite/TanStack (npm run build, lancé depuis la racine) génère
// ses fichiers dans "dist/client" à la racine du projet, pas dans
// "electron-windows/dist" : on pointe donc un niveau au-dessus.
const loadURL = serve({ directory: path.join(__dirname, "..", "dist", "client") });

function createWindow() {
  const iconPath = path.join(__dirname, "icon.png");
  const hasIcon = fs.existsSync(iconPath);

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: "#1B4332",
    ...(hasIcon ? { icon: iconPath } : {}),
    webPreferences: {
      contextIsolation: true,
    },
  });

  // En dev/local : sert le build statique généré par "npm run build" (TanStack Start)
  // via un mini-serveur HTTP local (electron-serve), plutôt que file:// qui casse
  // les chemins d'assets et le routing du dashboard.
  // Pour pointer vers l'app déployée en ligne à la place :
  // remplacez la ligne ci-dessous par : win.loadURL("https://votre-app.lovable.app");
  loadURL(win);
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});