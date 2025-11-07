// Gera manifest.json listando objetos em um bucket R2 via S3 API
// Uso:
//   node scripts/gen-manifest-r2.mjs \
//     --version 3 \
//     --db-url https://raw.githubusercontent.com/<user>/<repo>/main/data/catalog.db \
//     [--prefix ISAKA/] \
//     [--base-url https://<ACCOUNT>.r2.cloudflarestorage.com/<BUCKET>/] \
//     [--out manifest.json]
// Requer envs:
//   R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
//   (Opcional) R2_ENDPOINT, R2_PUBLIC_BASE_URL

import { writeFile } from 'node:fs/promises';
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

async function listAllObjects(s3, bucket, prefix) {
  const keys = [];
  let ContinuationToken = undefined;
  do {
    const out = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken }));
    (out.Contents || []).forEach(obj => { if (obj.Key && !obj.Key.endsWith('/')) keys.push(obj.Key); });
    ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return keys;
}

async function main() {
  const version = Number(arg('version'));
  const dbUrl = arg('db-url');
  const outPath = arg('out', 'manifest.json');
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
  const keys = await listAllObjects(s3, bucket, prefix);
  console.log(`Encontrados ${keys.length} arquivos.`);

  const files = keys.map(k => ({ file: k, sha256: null }));
  const manifest = { db: { version, url: dbUrl, sha256: null }, images: { base_url: baseUrl, files } };
  await writeFile(outPath, JSON.stringify(manifest, null, 2));
  console.log('Manifest escrito em', outPath);
}

main().catch(err => { console.error('Falha ao gerar manifest R2:', err); process.exit(1); });
