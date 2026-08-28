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

/**
 * Efface l'historique d'un client précis (utilisé par le bouton "Effacer
 * l'historique" de l'admin). Ne fait rien si le client n'a pas de conversation.
 */
export function deleteConversation(phone) {
  const conversations = loadConversations();
  delete conversations[phone];
  saveConversations(conversations);
}
