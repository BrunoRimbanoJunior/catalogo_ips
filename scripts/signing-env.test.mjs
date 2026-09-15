import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadLocalSigningEnv } from "./signing-env.mjs";

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), "catalogo-signing-env-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content);
  }
  return root;
}

test("loads signing settings without injecting development frontend or backend settings", (t) => {
  const root = fixture(t, {
    ".env.development": [
      "VITE_SUPABASE_URL=https://development.example.test",
      "VITE_SUPABASE_ANON_KEY=development-public-key",
      "VITE_SUPABASE_SERVICE_ROLE_KEY=backend-only-value",
      "SUPABASE_SERVICE_ROLE_KEY=backend-only-value",
      "export TAURI_SIGNING_PRIVATE_KEY_PATH='./private.key'",
      'TAURI_SIGNING_PRIVATE_KEY_PASSWORD="test=password"',
    ].join("\n"),
  });
  const env = {};
  loadLocalSigningEnv(env, root);
  assert.deepEqual(env, {
    TAURI_SIGNING_PRIVATE_KEY_PATH: "./private.key",
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "test=password",
  });
});

test("keeps existing process settings and uses local files before development defaults", (t) => {
  const root = fixture(t, {
    ".env.local": "TAURI_PRIVATE_KEY_PATH=local.key\nTAURI_KEY_PASSWORD=local-password",
    ".env.development.local": "TAURI_PRIVATE_KEY_PATH=dev-local.key\nTAURI_PRIVATE_KEY=dev-local-key",
    ".env.development": "TAURI_PRIVATE_KEY_PATH=dev.key\nTAURI_PRIVATE_KEY=dev-key\nTAURI_SIGNING_PRIVATE_KEY_PASSWORD=dev-password",
  });
  const env = {
    VITE_SUPABASE_URL: "https://production.example.test",
    TAURI_KEY_PASSWORD: "process-password",
  };
  loadLocalSigningEnv(env, root);
  assert.deepEqual(env, {
    VITE_SUPABASE_URL: "https://production.example.test",
    TAURI_KEY_PASSWORD: "process-password",
    TAURI_PRIVATE_KEY_PATH: "local.key",
    TAURI_PRIVATE_KEY: "dev-local-key",
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "dev-password",
  });
});

test("works when local signing files do not exist", (t) => {
  const env = { TAURI_SIGNING_PRIVATE_KEY: "process-key" };
  loadLocalSigningEnv(env, fixture(t, {}));
  assert.deepEqual(env, { TAURI_SIGNING_PRIVATE_KEY: "process-key" });
});
