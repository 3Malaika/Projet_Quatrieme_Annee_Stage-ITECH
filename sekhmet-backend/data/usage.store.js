import fs from "fs";

const USAGE_PATH = "./usage.json";

// Le fichier JSON n'est pas fait pour un historique illimité : on garde les
// entrées les plus récentes, largement suffisant pour calculer des totaux
// "aujourd'hui" / "ce mois-ci" sans faire grossir le fichier indéfiniment.
const MAX_ENTRIES = 5000;

export function loadUsage() {
  try {
    const raw = fs.readFileSync(USAGE_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function appendUsage(entry) {
  const all = loadUsage();
  all.push(entry);
  const trimmed = all.length > MAX_ENTRIES ? all.slice(-MAX_ENTRIES) : all;
  fs.writeFileSync(USAGE_PATH, JSON.stringify(trimmed, null, 2));
}
