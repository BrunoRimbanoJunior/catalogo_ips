import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const signingKeys = new Set([
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PATH",
  "TAURI_PRIVATE_KEY_PATH",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  "TAURI_KEY_PASSWORD",
  "TAURI_PRIVATE_KEY_PASSWORD",
]);

function unquoteEnvValue(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function loadLocalSigningEnv(env = process.env, cwd = process.cwd()) {
  // Vite loads the production frontend settings itself. Loading VITE_* from
  // development files into process.env would override those production values.
  for (const name of [".env.local", ".env.development.local", ".env.development"]) {
    const filePath = resolve(cwd, name);
    if (!existsSync(filePath)) continue;

    for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
      const eqIndex = normalized.indexOf("=");
      if (eqIndex <= 0) continue;

      const key = normalized.slice(0, eqIndex).trim();
      if (signingKeys.has(key) && !env[key]?.trim()) {
        env[key] = unquoteEnvValue(normalized.slice(eqIndex + 1));
      }
    }
  }
}
