/**
 * Client Supabase partagé pour tous les stores.
 * Utilise la clé SERVICE_ROLE pour un accès complet sans RLS.
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "../config/env.js";

export const supabase = createClient(
  config.supabaseUrl,
  config.supabaseServiceKey
);
