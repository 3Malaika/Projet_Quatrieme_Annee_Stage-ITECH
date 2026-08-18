import fs from "fs";

const BIENFAITS_PATH = "./bienfaits.txt";

export function loadBienfaits() {
  try {
    return fs.readFileSync(BIENFAITS_PATH, "utf-8");
  } catch (err) {
    return "";
  }
}

export function saveBienfaits(content) {
  fs.writeFileSync(BIENFAITS_PATH, content);
}
