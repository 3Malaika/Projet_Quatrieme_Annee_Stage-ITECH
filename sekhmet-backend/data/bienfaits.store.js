import { getSetting, setSetting } from "./sqlite.db.js";
export function loadBienfaits() { return getSetting("bienfaits", ""); }
export function saveBienfaits(content) { setSetting("bienfaits", content); }
