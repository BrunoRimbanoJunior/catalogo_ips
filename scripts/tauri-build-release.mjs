#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function getPrivateKey() {
  if (process.env.TAURI_PRIVATE_KEY?.trim()) {
    return process.env.TAURI_PRIVATE_KEY.trim();
  }

  const keyPath = resolve(process.env.TAURI_PRIVATE_KEY_PATH || "./private.key");
  if (!existsSync(keyPath)) {
    throw new Error(
      `TAURI_PRIVATE_KEY not set and file not found at ${keyPath}. Set env TAURI_PRIVATE_KEY or TAURI_PRIVATE_KEY_PATH`
    );
  }

  return readFileSync(keyPath, "utf8").trim();
}

function getKeyPassword() {
  const pwd =
    process.env.TAURI_KEY_PASSWORD || process.env.TAURI_PRIVATE_KEY_PASSWORD;
  if (!pwd?.trim()) {
    throw new Error(
      "Missing TAURI_KEY_PASSWORD (or TAURI_PRIVATE_KEY_PASSWORD) environment variable"
    );
  }
  return pwd.trim();
}

function main() {
  const privateKey = getPrivateKey();
  const keyPassword = getKeyPassword();

  // Make sure the Tauri CLI receives the signing material.
  process.env.TAURI_PRIVATE_KEY = privateKey;
  process.env.TAURI_KEY_PASSWORD = keyPassword;
  console.log("Signing env set; invoking pnpm tauri build");

  const extraArgs = process.argv.slice(2);
  const result = spawnSync("pnpm", ["tauri", "build", ...extraArgs], {
    stdio: "inherit",
    shell: true, // use shell so pnpm is resolved on Windows
  });

  if (result.status !== 0) {
    console.error("tauri build failed", {
      status: result.status,
      signal: result.signal,
      error: result.error?.message,
    });
    process.exit(result.status ?? 1);
  }
}

main();
