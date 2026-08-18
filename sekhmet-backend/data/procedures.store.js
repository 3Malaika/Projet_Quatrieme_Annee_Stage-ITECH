import fs from "fs";

const PROCEDURES_PATH = "./procedures.txt";

export function loadProcedures() {
  try {
    return fs.readFileSync(PROCEDURES_PATH, "utf-8");
  } catch (err) {
    return "Aucune procédure spécifique enregistrée.";
  }
}

export function saveProcedures(content) {
  fs.writeFileSync(PROCEDURES_PATH, content);
}
