import { getSetting, setSetting } from "./sqlite.db.js";
export function loadProcedures() { return getSetting("procedures", "Aucune procédure spécifique enregistrée."); }
export function saveProcedures(content) { setSetting("procedures", content); }
