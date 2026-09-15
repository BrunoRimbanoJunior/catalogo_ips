import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateFrontendEnv } from "../scripts/frontend-env.mjs";

const configured = { VITE_SUPABASE_URL: "https://example.supabase.co", VITE_SUPABASE_ANON_KEY: "sb_publishable_test" };
test("public config is accepted; each missing value fails without exposing values", () => {
  assert.doesNotThrow(() => validateFrontendEnv(configured));
  for (const name of Object.keys(configured)) {
    assert.throws(() => validateFrontendEnv({ ...configured, [name]: "  " }), (error) => {
      assert.match(error.message, new RegExp(name));
      assert.ok(!error.message.includes("sb_publishable_test"));
      return true;
    });
  }
});
test("invalid URL and privileged keys cannot be bundled", () => {
  assert.throws(() => validateFrontendEnv({ ...configured, VITE_SUPABASE_URL: "invalid" }), /URL HTTP/);
  const jwt = (role) => `header.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.signature`;
  assert.doesNotThrow(() => validateFrontendEnv({ ...configured, VITE_SUPABASE_ANON_KEY: jwt("anon") }));
  for (const key of ["sb_secret_test", jwt("service_role")]) {
    assert.throws(() => validateFrontendEnv({ ...configured, VITE_SUPABASE_ANON_KEY: key }), /chave pública/);
  }
});
test("actual Vite build rejects empty CI config even when local env files exist", () => {
  const result = spawnSync(process.execPath, ["node_modules/vite/bin/vite.js", "build"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, VITE_SUPABASE_URL: "", VITE_SUPABASE_ANON_KEY: "" },
    encoding: "utf8", timeout: 30000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Build cancelado/);
  assert.match(result.stderr, /VITE_SUPABASE_URL/);
  assert.match(result.stderr, /VITE_SUPABASE_ANON_KEY/);
});
