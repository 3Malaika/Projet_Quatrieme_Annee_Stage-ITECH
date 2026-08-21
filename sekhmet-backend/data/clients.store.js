import fs from "fs";
import { generateClientId } from "../utils/clientId.js";

const CLIENTS_PATH = "./clients.json";

export function loadClients() {
  try {
    const raw = fs.readFileSync(CLIENTS_PATH, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    return {};
  }
}

export function saveClients(clients) {
  fs.writeFileSync(CLIENTS_PATH, JSON.stringify(clients, null, 2));
}

export function getClient(phone) {
  return loadClients()[phone] || null;
}

export function upsertClient(phone, data) {
  const clients = loadClients();
  const existing = clients[phone] || {};

  // Génère un client_id si on vient d'obtenir le nom et qu'il n'en a pas encore
  let client_id = existing.client_id;
  if (!client_id && (data.nom || existing.nom)) {
    const nom = data.nom || existing.nom;
    const ordre = Object.keys(clients).length + (existing.phone ? 0 : 1);
    client_id = generateClientId(nom, ordre);
  }

  // besoins est un tableau — on ajoute le nouveau besoin s'il n'existe pas déjà
  const besoinsExistants = Array.isArray(existing.besoins) ? existing.besoins : 
    (existing.besoin ? [existing.besoin] : []); // migration ancien format
  const contactsAt = Array.isArray(existing.contacts_at) ? existing.contacts_at : [];

  let besoins = besoinsExistants;
  let contacts_at = contactsAt;

  if (data.besoin && !besoinsExistants.includes(data.besoin)) {
    besoins = [...besoinsExistants, data.besoin];
    contacts_at = [...contactsAt, new Date().toISOString()];
  }

  const { besoin, ...restData } = data; // on retire besoin (string) du payload

  clients[phone] = {
    ...existing,
    ...restData,
    phone,
    besoins,
    contacts_at,
    updated_at: new Date().toISOString(),
    ...(client_id ? { client_id } : {}),
  };
  saveClients(clients);
  return clients[phone];
}
