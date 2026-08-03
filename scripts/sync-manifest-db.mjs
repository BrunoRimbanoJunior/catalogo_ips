#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import initSqlJs from 'sql.js';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function repositoryName() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const remote = git('config', '--get', 'remote.origin.url');
  const match = remote.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/i);
  if (!match) throw new Error('Nao foi possivel identificar o repositorio GitHub.');
  return `${match[1]}/${match[2]}`;
}

async function main() {
  const manifestPath = arg('manifest', 'manifest.json');
  const outputPath = arg('out', manifestPath);
  const dbPath = arg('db', 'data/catalog.db');
  const dbBytes = await readFile(dbPath);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const SQL = await initSqlJs();
  const db = new SQL.Database(dbBytes);
  let dbVersion;

  try {
    dbVersion = Number(db.exec("SELECT value FROM meta WHERE key='db_version' LIMIT 1")?.[0]?.values?.[0]?.[0]);
  } finally {
    db.close();
  }

  if (!Number.isFinite(dbVersion) || dbVersion <= 0) {
    throw new Error(`${dbPath} nao contem um meta.db_version valido.`);
  }

  const commit = git('rev-parse', 'HEAD');
  const repository = repositoryName();
  const dbSha = createHash('sha256').update(dbBytes).digest('hex');
  manifest.db = {
    ...(manifest.db || {}),
    version: dbVersion,
    url: `https://raw.githubusercontent.com/${repository}/${commit}/${dbPath.replaceAll('\\', '/')}`,
    sha256: dbSha,
  };

  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Manifest sincronizado: db v${dbVersion}, commit ${commit}, sha256 ${dbSha}.`);
}

main().catch((error) => {
  console.error(`Falha ao sincronizar manifest: ${error.message}`);
  process.exit(1);
});
