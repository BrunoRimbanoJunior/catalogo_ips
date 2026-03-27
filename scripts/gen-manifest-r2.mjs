// Gera manifest.json listando objetos em um bucket R2 via S3 API.
// Em dev, se --version/--db-version/--db-url/--db-sha não forem passados,
// o script tenta reaproveitar manifest.json atual e o data/catalog.db local.

import { writeFile, readFile } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

const DEFAULT_DB_PATH = 'data/catalog.db';
const DEFAULT_MANIFEST_PATH = 'manifest.json';
const DEFAULT_RAW_DB_URL = 'https://raw.githubusercontent.com/BrunoRimbanoJunior/catalogo_ips/main/data/catalog.db';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i > -1 && process.argv[i + 1]) return process.argv[i + 1];
  return def;
}

function ensure(val, msg) {
  if (!val) {
    console.error(msg);
    process.exit(1);
  }
  return val;
}

function ensureNumber(val, msg) {
  const num = Number(val);
  if (!Number.isFinite(num) || num <= 0) {
    console.error(msg);
    process.exit(1);
  }
  return num;
}

function parseDotenv(text) {
  const out = {};
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

async function loadEnvFiles() {
  // Carrega .env.development e .env (nesta ordem); não sobrescreve env já definidos
  const files = ['.env.development', '.env'];
  for (const f of files) {
    try {
      if (!existsSync(f)) continue;
      const txt = await readFile(f, 'utf8');
      const parsed = parseDotenv(txt);
      for (const [k, v] of Object.entries(parsed)) {
        if (!process.env[k] || process.env[k] === '') process.env[k] = v;
      }
    } catch (_) {
      // ignore
    }
  }
}

function toUtcVersionStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return Number(
    `${pad(date.getUTCDate())}${pad(date.getUTCMonth() + 1)}${String(date.getUTCFullYear()).slice(-2)}${pad(date.getUTCHours())}`
  );
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function loadJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function guessDbUrlFromGit() {
  try {
    const remote = execSync('git config --get remote.origin.url', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const match = remote.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/i);
    if (!match) return DEFAULT_RAW_DB_URL;
    const owner = match[1];
    const repo = match[2];
    return `https://raw.githubusercontent.com/${owner}/${repo}/main/${DEFAULT_DB_PATH}`;
  } catch (_) {
    return DEFAULT_RAW_DB_URL;
  }
}

function cleanETag(tag) {
  if (!tag) return null;
  return String(tag).replace(/^\"|\"$/g, '');
}

async function listAllObjects(s3, bucket, prefix) {
  const items = [];
  let ContinuationToken = undefined;
  do {
    const out = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken }));
    (out.Contents || []).forEach(obj => {
      if (obj.Key && !obj.Key.endsWith('/')) items.push({ key: obj.Key, etag: cleanETag(obj.ETag) });
    });
    ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return items;
}

async function main() {
  await loadEnvFiles();

  const outPath = arg('out', DEFAULT_MANIFEST_PATH);
  const existingManifest = await loadJsonIfExists(outPath);
  const localDbSha = existsSync(DEFAULT_DB_PATH) ? await sha256File(DEFAULT_DB_PATH) : null;
  const existingDbVersion = Number(existingManifest?.db?.version);
  const existingDbSha = existingManifest?.db?.sha256 || null;
  const canReuseExistingVersion =
    Number.isFinite(existingDbVersion) &&
    existingDbVersion > 0 &&
    ((!localDbSha && !!existingManifest?.db?.url) || (!!localDbSha && !!existingDbSha && localDbSha === existingDbSha));
  const fallbackVersion =
    canReuseExistingVersion ? existingDbVersion : toUtcVersionStamp();

  const version = ensureNumber(
    arg('version', process.env.MANIFEST_VERSION || fallbackVersion),
    'Defina um --version válido ou MANIFEST_VERSION.'
  );
  const dbVersion = ensureNumber(
    arg('db-version', process.env.MANIFEST_DB_VERSION || version),
    'Defina um --db-version válido ou MANIFEST_DB_VERSION.'
  );
  const dbSha = arg('db-sha', process.env.MANIFEST_DB_SHA || localDbSha || existingDbSha || null);
  const dbUrl = arg('db-url', process.env.MANIFEST_DB_URL || existingManifest?.db?.url || guessDbUrlFromGit());
  const appVersion = arg('app-version', process.env.APP_VERSION || process.env.VITE_APP_VERSION || null);
  const appDownloadUrl = arg('app-download-url', process.env.MANIFEST_APP_DOWNLOAD_URL || process.env.APP_DOWNLOAD_URL || null);
  const prefix = arg('prefix', '');

  ensure(dbUrl, 'Faltou --db-url');

  const accountId = ensure(process.env.R2_ACCOUNT_ID, 'Defina R2_ACCOUNT_ID');
  const bucket = ensure(process.env.R2_BUCKET, 'Defina R2_BUCKET (nome exato do bucket no R2)');
  const accessKeyId = ensure(process.env.R2_ACCESS_KEY_ID, 'Defina R2_ACCESS_KEY_ID');
  const secretAccessKey = ensure(process.env.R2_SECRET_ACCESS_KEY, 'Defina R2_SECRET_ACCESS_KEY');

  const endpoint = process.env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`;
  let baseUrl = (arg('base-url') || process.env.R2_PUBLIC_BASE_URL || `${endpoint}/${bucket}/`).replace(/([^/])$/, '$1/');
  // Proteção: se usarem o endpoint público da conta sem o bucket, garanta que o bucket entre na URL
  // Ex.: https://<account>.r2.cloudflarestorage.com/  -> precisa de /<bucket>/
  if (baseUrl.includes(`${accountId}.r2.cloudflarestorage.com`) && bucket && !baseUrl.includes(`/${bucket}/`)) {
    baseUrl = `${baseUrl}${bucket}/`;
  }

  const s3 = new S3Client({
    region: 'auto',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });

  console.log('Gerando manifest R2...', { outPath, version, dbVersion, dbUrl });
  console.log('Listando objetos do R2...', { bucket, prefix, endpoint });
  let objects;
  try {
    objects = await listAllObjects(s3, bucket, prefix);
  } catch (err) {
    const code = (err && (err.name || err.Code)) || 'UnknownError';
    const status = (err && err.$metadata && err.$metadata.httpStatusCode) || (err && err.statusCode) || 'n/a';
    throw new Error(`Falha ao listar objetos no R2 (bucket="${bucket}", endpoint="${endpoint}"): ${code} (HTTP ${status}). Verifique: R2_BUCKET, Account ID/endpoint e permissões do token (List/Read no bucket). Detalhe: ${err}`);
  }
  console.log(`Encontrados ${objects.length} arquivos.`);

  const files = objects.map(o => ({ file: o.key, sha256: o.etag || null }));
  const computedDownload =
    appDownloadUrl ||
    (appVersion ? `https://github.com/BrunoRimbanoJunior/catalogo_ips/releases/download/v${appVersion}/catalogo_ips_x64-setup.exe` : null);
  const manifest = {
    appVersion: appVersion || undefined,
    appDownloadUrl: computedDownload || undefined,
    db: { version: dbVersion || version, url: dbUrl, sha256: dbSha || null },
    images: { base_url: baseUrl, files },
  };
  Object.keys(manifest).forEach((k) => manifest[k] === undefined && delete manifest[k]);
  await writeFile(outPath, JSON.stringify(manifest, null, 2));
  console.log('Manifest escrito em', outPath);
}

main().catch(err => { console.error('Falha ao gerar manifest R2:', err); process.exit(1); });

