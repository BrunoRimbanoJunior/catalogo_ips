// Copia arquivos de logo e/ou background para public/branding
// Uso:
//   node scripts/set-branding.mjs --logo C:\imagens\logo.png --bg C:\imagens\fundo.jpg
// Saída:
//   public/branding/{logo.ext,bg.ext} e public/branding/branding.json

import { mkdir, copyFile, writeFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i > -1) return process.argv[i + 1];
  return undefined;
}

async function ensureDir(p) {
  try { await mkdir(p, { recursive: true }); } catch {}
}

async function main() {
  const logo = arg('logo');
  const bg = arg('bg');
  if (!logo && !bg) {
    console.error('Uso: node scripts/set-branding.mjs [--logo caminho] [--bg caminho]');
    process.exit(1);
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const outDir = resolve(root, 'public', 'images');
  await ensureDir(outDir);

  const manifest = { logo: null, background: null };

  if (logo) {
    const ext = extname(logo) || '.png';
    const dest = resolve(outDir, `logo${ext}`);
    await copyFile(logo, dest);
    manifest.logo = `logo${ext}`;
    console.log('Logo copiada para', dest);
  }
  if (bg) {
    const ext = extname(bg) || '.jpg';
    const dest = resolve(outDir, `bg${ext}`);
    await copyFile(bg, dest);
    manifest.background = `bg${ext}`;
    console.log('Background copiado para', dest);
  }

  const jsonPath = resolve(outDir, 'branding.json');
  await writeFile(jsonPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log('Manifesto de branding escrito em', jsonPath);
}

main().catch((e) => { console.error('Falha ao definir branding:', e); process.exit(1); });
