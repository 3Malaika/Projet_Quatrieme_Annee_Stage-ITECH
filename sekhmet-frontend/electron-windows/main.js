const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");

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

  // En dev/local : charge le build statique généré par "npm run build" (TanStack Start),
  // dont le fichier d'entrée renommé _shell.html -> index.html a été copié dans dist/.
  // Si vous préférez pointer directement vers l'app déployée en ligne,
  // remplacez la ligne ci-dessous par : win.loadURL("https://votre-app.lovable.app");
  win.loadFile(path.join(__dirname, "dist", "index.html"));
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
