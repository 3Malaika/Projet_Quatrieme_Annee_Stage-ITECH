/**
 * Configuration globale de l'application Sekhmet Shop Admin.
 *
 * Ces deux valeurs sont les seuls points à modifier entre la version web,
 * l'APK Android et l'EXE Windows. Elles peuvent être surchargées via des
 * variables d'environnement de build (VITE_API_BASE_URL / VITE_ADMIN_TOKEN).
 *
 * Le token n'est JAMAIS stocké dans localStorage / sessionStorage : il reste
 * en mémoire (constante de module) pour rester compatible avec les webviews.
 */

export const API_BASE_URL =
  (import.meta.env["VITE_API_BASE_URL"] as string | undefined) ?? "http://localhost:3000";

export const ADMIN_TOKEN =
  (import.meta.env["VITE_ADMIN_TOKEN"] as string | undefined) ?? "CHANGEZ_MOI";

