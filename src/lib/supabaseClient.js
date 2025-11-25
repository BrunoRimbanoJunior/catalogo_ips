import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabaseServiceKeyRaw = import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY;

export let supabase = null;
export let supabaseService = null;
export const supabaseServiceKey = supabaseServiceKeyRaw || "";
export const supabaseRestUrl = supabaseUrl || "";

if (supabaseUrl && supabaseAnonKey) {
  supabase = createClient(supabaseUrl, supabaseAnonKey);
} else {
  console.warn("Supabase URL ou Anon Key não configurados. Preencha VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY no .env.");
}

if (supabaseUrl && supabaseServiceKeyRaw && import.meta.env.DEV) {
  supabaseService = createClient(supabaseUrl, supabaseServiceKeyRaw, {
    auth: { autoRefreshToken: false, persistSession: false, storageKey: "sb-service-dev" },
    global: {
      headers: {
        apikey: supabaseServiceKeyRaw,
        Authorization: `Bearer ${supabaseServiceKeyRaw}`,
      },
    },
  });
}
