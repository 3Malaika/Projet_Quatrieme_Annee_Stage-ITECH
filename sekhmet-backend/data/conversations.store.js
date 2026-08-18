import fs from "fs";

const CONVERSATIONS_PATH = "./conversations.json";

/**
 * Charge toutes les conversations depuis le fichier JSON.
 * Retourne un objet { [phone]: [ ...messages ] }
 */
export function loadConversations() {
  try {
    const raw = fs.readFileSync(CONVERSATIONS_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Sauvegarde toutes les conversations dans le fichier JSON.
 */
export function saveConversations(conversations) {
  fs.writeFileSync(CONVERSATIONS_PATH, JSON.stringify(conversations, null, 2));
}
