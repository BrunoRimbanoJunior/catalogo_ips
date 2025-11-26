// Gera manifest.json listando objetos em um bucket R2 via S3 API
// Requer envs:
//   R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
//   (Opcional) R2_ENDPOINT, R2_PUBLIC_BASE_URL

import { writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

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

  const version = Number(arg('version'));
  const dbUrl = arg('db-url');
  const outPath = arg('out', 'manifest.json');
  const appVersion = arg('app-version', process.env.APP_VERSION || null);
  const appDownloadUrl = arg('app-download-url', process.env.APP_DOWNLOAD_URL || null);
  const prefix = arg('prefix', '');

  ensure(version, 'Faltou --version');
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
  const computedDownload = appDownloadUrl || (appVersion ? `https://github.com/BrunoRimbanoJunior/catalogo_ips/releases/tag/v${appVersion}` : null);
  const manifest = {
    appVersion: appVersion || undefined,
    appDownloadUrl: computedDownload || undefined,
    db: { version, url: dbUrl, sha256: null },
    images: { base_url: baseUrl, files },
  };
  Object.keys(manifest).forEach((k) => manifest[k] === undefined && delete manifest[k]);
  await writeFile(outPath, JSON.stringify(manifest, null, 2));
  console.log('Manifest escrito em', outPath);
}

main().catch(err => { console.error('Falha ao gerar manifest R2:', err); process.exit(1); });

