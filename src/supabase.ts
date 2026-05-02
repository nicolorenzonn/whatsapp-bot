// Cliente de Supabase con SERVICE_ROLE — el bot bypass-ea RLS porque
// corre fuera del flow de auth. Por eso filtramos manualmente por
// user_id (config.userId) en cada query.
import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";

export const sb = createClient(config.supabaseUrl, config.supabaseServiceKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});
