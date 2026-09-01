import { getSetting, setSetting } from "./sqlite.db.js";
const DEFAULT_MESSAGE = "Bonjour 👋 et merci de nous avoir contactés ! Un conseiller va prendre en charge votre demande.";
export function loadOpeningMessage() { return (getSetting("message_ouverture", DEFAULT_MESSAGE) || DEFAULT_MESSAGE).trim() || DEFAULT_MESSAGE; }
export function saveOpeningMessage(content) { setSetting("message_ouverture", content); }
