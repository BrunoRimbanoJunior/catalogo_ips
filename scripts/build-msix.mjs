#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { msixVersion, packageManifest } from './msix-manifest.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

function run(command, args, env = process.env) {
  const sdk = /^make(appx|pri)\.exe$/i.test(path.basename(command));
  const result = spawnSync(command, args, { cwd: root, env, stdio: sdk ? 'pipe' : 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const decode = (bytes) => bytes?.toString(bytes[1] === 0 ? 'utf16le' : 'utf8').replaceAll('\0', '') || '';
    throw new Error(`${path.basename(command)} falhou (${result.status ?? result.signal}).\n${decode(result.stdout)}${decode(result.stderr)}`);
  }
  if (sdk) console.log(`${path.basename(command)} ${args[0]}: OK`);
}

async function sdkTool(name) {
  const bin = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
  const versions = (await readdir(bin)).filter((item) => /^\d+\.\d+\.\d+\.\d+$/.test(item));
  versions.sort((a, b) => {
    const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
    for (let i = 0; i < 4; i++) if (aa[i] !== bb[i]) return bb[i] - aa[i];
    return 0;
  });
  for (const version of versions) {
    const candidate = path.join(bin, version, 'x64', name);
    try { await stat(candidate); return candidate; } catch { /* try the next SDK */ }
  }
  throw new Error(`${name} não encontrado: instale as ferramentas do Windows SDK.`);
}

async function checkX64Executable(file) {
  const bytes = await readFile(file);
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Executável não é PE.');
  const pe = bytes.readUInt32LE(60);
  if (pe + 6 > bytes.length || bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0' || bytes.readUInt16LE(pe + 4) !== 0x8664) {
    throw new Error('Este empacotamento exige um executável Windows x64.');
  }
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('pnpm msix:build [--identity caminho.json]\nGera um MSIX x64 para submissão à Store, sem assinatura local.');
    return;
  }
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Execute em Windows x64.');
  const index = process.argv.indexOf('--identity');
  if (index >= 0 && !process.argv[index + 1]) throw new Error('--identity exige um caminho JSON.');
  const identityFile = path.resolve(root, index < 0 ? 'packaging/msix/store-identity.json' : process.argv[index + 1]);
  let identity;
  try {
    identity = JSON.parse(await readFile(identityFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Configure packaging/msix/store-identity.json com a identidade exata do Partner Center; use store-identity.example.json como modelo.');
    throw error;
  }
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const version = msixVersion(pkg.version);
  const manifestXml = packageManifest(identity, pkg.version);
  // db.url will reference HEAD; never attach a new hash to an older committed DB.
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const committedDb = execFileSync('git', ['show', 'HEAD:data/catalog.db'], { cwd: root, maxBuffer: 256 * 1024 * 1024 });
  if (hash(committedDb) !== hash(await readFile(path.join(root, 'data/catalog.db')))) {
    throw new Error('Comite data/catalog.db antes do build: a URL imutável precisa corresponder ao banco empacotado.');
  }
  const makeappx = await sdkTool('makeappx.exe');
  const makepri = await sdkTool('makepri.exe');
  const outDir = path.join(root, 'dist-msix');
  await mkdir(outDir, { recursive: true });
  const work = await mkdtemp(path.join(outDir, 'work-'));
  const stage = path.join(work, 'package');
  await mkdir(path.join(stage, 'Assets'), { recursive: true });
  await mkdir(path.join(stage, 'data'), { recursive: true });

  // Only public runtime resources enter the package; no env files, keys, PDBs or backend.
  const catalogManifest = path.join(stage, 'manifest.json');
  run(process.execPath, ['scripts/sync-manifest-db.mjs', '--out', catalogManifest]);
  run(process.execPath, ['scripts/validate-manifest.mjs', '--manifest', catalogManifest, '--db', 'data/catalog.db']);
  const catalog = JSON.parse(await readFile(catalogManifest, 'utf8'));
  catalog.appVersion = pkg.version;
  catalog.appDownloadUrl = `https://github.com/BrunoRimbanoJunior/catalogo_ips/releases/download/v${pkg.version}/catalogo_ips_x64-setup.exe`;
  await writeFile(catalogManifest, `${JSON.stringify(catalog, null, 2)}\n`);
  await copyFile(path.join(root, 'data/catalog.db'), path.join(stage, 'data/catalog.db'));
  const hashesBefore = catalog.db.sha256;

  console.log(`Compilando edição Microsoft Store ${version}...`);
  const targetDir = path.join(root, 'src-tauri/target/msix');
  run(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', 'build', '--no-bundle', '--features', 'microsoft-store',
    '--config', 'src-tauri/tauri.msix.conf.json'], {
    ...process.env, VITE_DISTRIBUTION_CHANNEL: 'microsoft-store', VITE_APP_VERSION: pkg.version, CARGO_TARGET_DIR: targetDir,
    // Use the installed pnpm for the CLI's dependency inspection; don't bootstrap
    // another package manager during a build with dependencies already installed.
    npm_config_manage_package_manager_versions: 'false',
  });
  const assets = path.join(root, 'dist/assets');
  for (const file of await readdir(assets)) {
    if (file.endsWith('.js') && (await readFile(path.join(assets, file), 'utf8')).includes('plugin:updater|')) {
      throw new Error('O frontend contém o updater externo. Confira VITE_DISTRIBUTION_CHANNEL.');
    }
  }
  const executable = path.join(targetDir, 'release/catalogo_ips.exe');
  await checkX64Executable(executable);
  await copyFile(executable, path.join(stage, 'catalogo_ips.exe'));
  // Tauri normally links the WebView2 loader statically; copy any emitted runtime DLLs.
  for (const file of await readdir(path.join(targetDir, 'release'))) {
    if (file.toLowerCase().endsWith('.dll')) await copyFile(path.join(targetDir, 'release', file), path.join(stage, file));
  }
  for (const [file, size] of [['Square150x150Logo.png', 150], ['Square44x44Logo.png', 44], ['StoreLogo.png', 50]]) {
    const icon = path.join(root, 'src-tauri/icons', file);
    const bytes = await readFile(icon);
    if (bytes.length < 24 || bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a' ||
        bytes.readUInt32BE(16) !== size || bytes.readUInt32BE(20) !== size) {
      throw new Error(`Ícone ${file} deve ser PNG ${size}x${size}.`);
    }
    await copyFile(icon, path.join(stage, 'Assets', file));
  }
  await writeFile(path.join(stage, 'AppxManifest.xml'), manifestXml);

  // Generate the resource index with SDK validation enabled.
  const priConfig = path.join(work, 'priconfig.xml');
  run(makepri, ['createconfig', '/cf', priConfig, '/dq', 'pt-BR', '/o']);
  run(makepri, ['new', '/pr', stage, '/cf', priConfig, '/of', path.join(work, 'resources.pri'), '/o']);
  await copyFile(path.join(work, 'resources.pri'), path.join(stage, 'resources.pri'));
  // Fail if data changed during a long compilation: package and source must match.
  const currentHash = createHash('sha256').update(await readFile(path.join(root, 'data/catalog.db'))).digest('hex');
  if (currentHash !== hashesBefore) throw new Error('O banco mudou durante o build. Gere o pacote novamente.');
  run(process.execPath, ['scripts/validate-manifest.mjs', '--manifest', catalogManifest, '--db', path.join(stage, 'data/catalog.db')]);
  const output = path.join(outDir, `catalogo_ips_${version}_x64.msix`);
  // No /nv: semantic validation remains enabled. Store signs the submitted package.
  run(makeappx, ['pack', '/d', stage, '/p', output, '/o']);
  const sha256 = createHash('sha256').update(await readFile(output)).digest('hex');
  await writeFile(`${output}.sha256`, `${sha256}  ${path.basename(output)}\n`);
  console.log(`\nMSIX para upload no Partner Center: ${output}\nSHA256: ${sha256}\nStaging para teste de desenvolvimento: ${stage}\nSem assinatura local: a Store assina após certificação; este arquivo não é um instalador para sideload.`);
}

main().catch((error) => { console.error(`Build MSIX cancelado: ${error.message}`); process.exitCode = 1; });
