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

// Petit mécanisme d'abonnement, volontairement séparé du reste : logger.js
// est un util de bas niveau et ne doit rien savoir de la persistance ou du
// dashboard. services/systemLogs.service.js s'abonne ici pour capturer les
// logs "error" les plus importants (échec Groq, échec WhatsApp/Meta, etc.)
// et les rendre visibles côté admin, sans coupler ce fichier à Supabase/JSON.
const importantSubscribers = [];

export function onImportantLog(fn) {
  importantSubscribers.push(fn);
}

function notifyImportant(level, context, message, extra) {
  for (const fn of importantSubscribers) {
    try {
      fn({ level, context, message, extra });
    } catch (e) {
      // Un abonné qui plante (ex: écriture DB indisponible) ne doit jamais
      // faire échouer l'appel à log.error() lui-même.
      console.error("[logger] échec d'un abonné onImportantLog", e);
    }
  }
}

export function createLogger(context) {
  return {
    info: (message, extra) => console.log(format("INFO", context, message, extra)),
    warn: (message, extra) => console.warn(format("WARN", context, message, extra)),
    error: (message, extra) => {
      console.error(format("ERROR", context, message, extra));
      notifyImportant("error", context, message, extra);
    },
    debug: (message, extra) => {
      if (process.env.DEBUG) console.log(format("DEBUG", context, message, extra));
    },
  };
}
