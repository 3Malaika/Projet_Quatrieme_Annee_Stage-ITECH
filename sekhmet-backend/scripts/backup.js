import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dbPathname } from "../data/sqlite.db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backupDir = path.resolve(__dirname, "../backups");
fs.mkdirSync(backupDir, { recursive: true });
const target = path.join(backupDir, `sekhmet-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
fs.copyFileSync(dbPathname, target);
console.log(`Sauvegarde créée : ${target}`);
