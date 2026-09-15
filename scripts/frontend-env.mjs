// Never include configured values in errors: CI output is shared with release logs.
export function validateFrontendEnv(env) {
  const names = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"];
  const missing = names.filter((name) => !String(env[name] || "").trim());
  if (missing.length) {
    throw new Error(`Build cancelado: configure ${missing.join(" e ")} no ambiente de build ou em .env.production. No GitHub, use Settings > Secrets and variables > Actions.`);
  }
  let url;
  try { url = new URL(env.VITE_SUPABASE_URL); } catch { /* reported below */ }
  if (!url || !["http:", "https:"].includes(url.protocol)) {
    throw new Error("Build cancelado: VITE_SUPABASE_URL precisa ser uma URL HTTP(S) válida.");
  }
  const key = String(env.VITE_SUPABASE_ANON_KEY).trim();
  let role;
  try { role = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString()).role; } catch { /* publishable keys are not JWTs */ }
  if (key.startsWith("sb_secret_") || role === "service_role") {
    throw new Error("Build cancelado: VITE_SUPABASE_ANON_KEY deve ser a chave pública anon/publishable, nunca service_role/secret.");
  }
}
