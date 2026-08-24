// Logger minimaliste, sans dépendance : chaque ligne a un horodatage, un
// niveau et un "contexte" (nom du module/flux) pour qu'on retrouve
// immédiatement d'où vient un log dans un fichier de logs qui grossit vite.
//
// Usage :
//   import { createLogger } from "../utils/logger.js";
//   const log = createLogger("webhook");
//   log.info("Message reçu", { from, length: userMessage.length });
//   log.error("Échec envoi", err);

function timestamp() {
  return new Date().toISOString();
}

function format(level, context, message, extra) {
  const base = `[${timestamp()}] [${level}] [${context}] ${message}`;
  if (extra === undefined) return base;
  if (extra instanceof Error) {
    return `${base} — ${extra.message}\n${extra.stack}`;
  }
  try {
    return `${base} ${JSON.stringify(extra)}`;
  } catch {
    return `${base} ${String(extra)}`;
  }
}

export function createLogger(context) {
  return {
    info: (message, extra) => console.log(format("INFO", context, message, extra)),
    warn: (message, extra) => console.warn(format("WARN", context, message, extra)),
    error: (message, extra) => console.error(format("ERROR", context, message, extra)),
    debug: (message, extra) => {
      if (process.env.DEBUG) console.log(format("DEBUG", context, message, extra));
    },
  };
}
