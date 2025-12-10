#!/usr/bin/env node

import fs from "fs";
import path from "path";

const version =
  process.env.APP_VERSION?.trim() ||
  (() => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
      return pkg.version;
    } catch (err) {
      return "";
    }
  })();

if (!version) {
  throw new Error("APP_VERSION not set (expected from tag, env, or package.json)");
}

const root = process.cwd();

function readJson(relPath) {
  const filePath = path.join(root, relPath);
  return { filePath, data: JSON.parse(fs.readFileSync(filePath, "utf8")) };
}

function writeJson(relPath, data) {
  const filePath = path.join(root, relPath);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function updateEnvFile(relPath, fallbackRelPath) {
  let filePath = path.join(root, relPath);
  if (!fs.existsSync(filePath) && fallbackRelPath) {
    // Se o env de dev não existir (CI), atualiza o de produção
    filePath = path.join(root, fallbackRelPath);
  }
  if (!fs.existsSync(filePath)) {
    console.warn(`Skipped ${relPath}: file not found`);
    return;
  }
  const content = fs.readFileSync(filePath, "utf8");
  const updated = content.match(/^VITE_APP_VERSION=.*$/m)
    ? content.replace(/^VITE_APP_VERSION=.*$/gm, `VITE_APP_VERSION=${version}`)
    : content.replace(/\s*$/, `\nVITE_APP_VERSION=${version}\n`);
  fs.writeFileSync(filePath, updated);
}

// package.json
{
  const { data } = readJson("package.json");
  data.version = version;
  writeJson("package.json", data);
}

// src-tauri/tauri.conf.json
{
  const { data } = readJson("src-tauri/tauri.conf.json");
  data.version = version;
  writeJson("src-tauri/tauri.conf.json", data);
}

// .env files que expõem versão ao front; se .env.development não existir (CI),
// caímos para .env.production.
updateEnvFile(".env.production");
updateEnvFile(".env.development", ".env.production");
updateEnvFile(".env.example");

console.log(`Synced version to ${version}`);
