import { getSetting, setSetting, parseJson } from "./sqlite.db.js";
function normalizeComptes(parsed) { if (Array.isArray(parsed)) return parsed.map(c => ({numero:c?.numero||"",nom:c?.nom||""})).filter(c=>c.numero); if (parsed?.numero) return [{numero:parsed.numero,nom:parsed.nom||""}]; return []; }
export function loadPaiementComptes() { return normalizeComptes(parseJson(getSetting("paiement_comptes", "[]"), [])); }
export function savePaiementComptes(comptes) { const n=(comptes||[]).map(c=>({numero:(c.numero||"").trim(),nom:(c.nom||"").trim()})).filter(c=>c.numero); setSetting("paiement_comptes", n); return n; }
export function loadPaiementCompte() { return loadPaiementComptes()[0] || {numero:"",nom:""}; }
export function savePaiementCompte({numero,nom}) { return savePaiementComptes([{numero,nom}])[0] || {numero:"",nom:""}; }
