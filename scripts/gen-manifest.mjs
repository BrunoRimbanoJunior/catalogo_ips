#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';

function arg(name, def) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return process.env[name.toUpperCase()] ?? def;
}

async function listFiles(root) {
  const out = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(p);
    }
  }
  await walk(root);
  return out;
}

async function main() {
  const version = Number(arg('version', 1));
  const dbUrl = arg('db-url');
  const imagesBase = arg('images-base-url');
  const imagesDir = arg('images-dir', 'images');
  const output = arg('out', 'manifest.json');
  if (!dbUrl || !imagesBase) {
    console.error('Uso: node scripts/gen-manifest.mjs --version 3 --db-url https://raw.githubusercontent.com/user/repo/main/data/catalog.db --images-base-url https://raw.githubusercontent.com/user/repo/main/images/ [--images-dir data/images] [--out manifest.json]');
    process.exit(2);
  }
  const all = await listFiles(imagesDir);
  const files = all
    .filter((p) => /\.(jpe?g|png|webp|bmp)$/i.test(p))
    .map((p) => path.relative(imagesDir, p).replace(/\\/g, '/'))
    .sort()
    .map((file) => ({ file }));
  const manifest = { db: { version, url: dbUrl }, images: { base_url: imagesBase.endsWith('/') ? imagesBase : imagesBase + '/', files } };
  await fs.writeFile(output, JSON.stringify(manifest, null, 2));
  console.log('Manifesto gerado em', output, 'com', files.length, 'imagens.');
}

main().catch((e) => { console.error(e); process.exit(1); });

