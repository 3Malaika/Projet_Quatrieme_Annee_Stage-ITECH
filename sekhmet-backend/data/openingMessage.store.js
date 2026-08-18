import fs from "fs";

const OPENING_MESSAGE_PATH = "./message_ouverture.txt";

const DEFAULT_MESSAGE =
  "Bonjour 👋 et merci de nous avoir contactés ! Un conseiller va prendre en charge votre demande.";

export function loadOpeningMessage() {
  try {
    const content = fs.readFileSync(OPENING_MESSAGE_PATH, "utf-8").trim();
    return content || DEFAULT_MESSAGE;
  } catch (err) {
    return DEFAULT_MESSAGE;
  }
}

export function saveOpeningMessage(content) {
  fs.writeFileSync(OPENING_MESSAGE_PATH, content);
}
