import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export let supabase = null;
export const supabaseRestUrl = supabaseUrl || "";

if (supabaseUrl && supabaseAnonKey) {
  supabase = createClient(supabaseUrl, supabaseAnonKey);
} else {
  console.warn("Supabase URL ou Anon Key não configurados. Preencha VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY no .env.");
}

if (import.meta.env.DEV) {
  console.log("SUPA URL:", supabaseUrl);
  console.log("ANON KEY prefix:", (supabaseAnonKey || "").slice(0, 8));
}
