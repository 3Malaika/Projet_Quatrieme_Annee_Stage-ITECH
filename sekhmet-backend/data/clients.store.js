import fs from "fs";

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

// Fusionne les nouvelles infos avec ce qui existe déjà pour ce client
// (ex : on connaît déjà le besoin, on vient d'apprendre le nom).
export function upsertClient(phone, data) {
  const clients = loadClients();
  clients[phone] = {
    ...(clients[phone] || {}),
    ...data,
    phone,
  };
  saveClients(clients);
  return clients[phone];
}
