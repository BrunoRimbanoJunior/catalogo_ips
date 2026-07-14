#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import initSqlJs from 'sql.js';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(message) {
  throw new Error(message);
}

async function validateDatabase(bytes, expectedVersion, label) {
  if (bytes.length < 4096 || !Buffer.from(bytes).subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) {
    fail(`${label} não é um banco SQLite válido.`);
  }

  const SQL = await initSqlJs();
  const db = new SQL.Database(bytes);
  try {
    const quickCheck = db.exec('PRAGMA quick_check')?.[0]?.values?.[0]?.[0];
    if (String(quickCheck).toLowerCase() !== 'ok') fail(`${label}: PRAGMA quick_check retornou ${quickCheck}.`);

    const products = Number(db.exec('SELECT COUNT(1) FROM products')?.[0]?.values?.[0]?.[0]);
    if (!Number.isFinite(products) || products <= 0) fail(`${label}: tabela products está vazia.`);

    const dbVersion = Number(db.exec("SELECT value FROM meta WHERE key='db_version' LIMIT 1")?.[0]?.values?.[0]?.[0]);
    if (dbVersion !== Number(expectedVersion)) {
      fail(`${label}: db_version ${dbVersion} difere do manifest ${expectedVersion}.`);
    }
    return { products, dbVersion };
  } finally {
    db.close();
  }
}

async function main() {
  const manifestPath = arg('manifest', 'manifest.json');
  const dbPath = arg('db', 'data/catalog.db');
  const checkRemote = process.argv.includes('--check-remote');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  if (!manifest?.db?.url || !manifest?.db?.sha256 || !Number.isFinite(Number(manifest?.db?.version))) {
    fail('Manifest precisa conter db.url, db.sha256 e db.version válidos.');
  }

  const localBytes = await readFile(dbPath);
  const localSha = sha256(localBytes);
  const localInfo = await validateDatabase(localBytes, manifest.db.version, 'Banco local');
  if (localSha.toLowerCase() !== String(manifest.db.sha256).toLowerCase()) {
    fail(`SHA local ${localSha} difere do manifest ${manifest.db.sha256}.`);
  }

  if (checkRemote) {
    const separator = manifest.db.url.includes('?') ? '&' : '?';
    const response = await fetch(`${manifest.db.url}${separator}integrity=${localSha}`, {
      headers: { 'accept-encoding': 'identity', 'user-agent': 'catalogo-ips-manifest-validator' },
      redirect: 'follow',
    });
    if (!response.ok) fail(`Download de ${manifest.db.url} falhou: HTTP ${response.status}.`);
    const remoteBytes = new Uint8Array(await response.arrayBuffer());
    const remoteSha = sha256(remoteBytes);
    if (remoteSha !== localSha) fail(`SHA remoto ${remoteSha} difere do banco local ${localSha}.`);
    await validateDatabase(remoteBytes, manifest.db.version, 'Banco remoto');
  }

  console.log(`Manifest válido: db v${manifest.db.version}, ${localInfo.products} produtos, sha256 ${localSha}.`);
}

main().catch((error) => {
  console.error(`Falha na validação do manifest: ${error.message}`);
  process.exit(1);
});
