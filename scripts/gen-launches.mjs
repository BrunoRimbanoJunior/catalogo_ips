#!/usr/bin/env node
/**
 * Gera um JSON de lançamentos a partir de uma pasta com imagens.
 * Uso:
 *   node scripts/gen-launches.mjs --dir ./tmp/lancamentos --base-url https://bucket/LANCAMENTOS/ --out ./lancamentos.json
 *
 * O JSON de saída fica assim:
 *   { "images": ["https://bucket/LANCAMENTOS/img1.jpg", "https://bucket/LANCAMENTOS/img2.png"] }
 */
import fs from "fs";
import path from "path";

function arg(name, def = undefined) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return def;
}

const dir = arg("dir");
const baseUrlRaw = arg("base-url");
const out = arg("out", "./lancamentos.json");

if (!dir || !baseUrlRaw) {
  console.error("Informe --dir <pasta de imagens> e --base-url <URL pública do diretório>.");
  process.exit(1);
}

if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
  console.error(`Pasta inválida: ${dir}`);
  process.exit(1);
}

const baseUrl = baseUrlRaw.replace(/([^/])$/, "$1/"); // garante barra final
const allowedExt = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const files = fs
  .readdirSync(dir)
  .filter((f) => allowedExt.has(path.extname(f).toLowerCase()))
  .sort((a, b) => a.localeCompare(b));

const images = files.map((f) => `${baseUrl}${f}`);
const payload = { images };

fs.writeFileSync(out, JSON.stringify(payload, null, 2));
console.log(`Gerado ${out} com ${images.length} imagens.`);
