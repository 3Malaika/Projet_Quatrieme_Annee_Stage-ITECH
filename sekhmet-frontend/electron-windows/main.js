const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");
const serve = require("electron-serve");

const loadURL = serve({ directory: path.join(__dirname, "dist") });

function createWindow() {
  const iconPath = path.join(__dirname, "icon.ico");
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