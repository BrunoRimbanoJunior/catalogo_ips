#!/usr/bin/env node
// Generate manifest.json using OneDrive (Microsoft Graph) public share links
// Auth: Device Code flow (interactive in terminal)

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { PublicClientApplication } from '@azure/msal-node';

const help = `
Usage:
  node scripts/gen-manifest-onedrive.mjs \
    --version 3 \
    --db-url https://raw.githubusercontent.com/<user>/<repo>/main/data/catalog.db \
    --folder-path /Catalogo/Imagens \
    --out manifest.json

Env (or flags):
  O365_CLIENT_ID / --client-id   Azure App (Public client) ID (required)
  O365_AUTHORITY / --authority   Login authority (default: https://login.microsoftonline.com/consumers)
  O365_SCOPES / --scopes         Scopes (default: Files.Read.All, offline_access)

Notes:
  - The script creates anonymous 'view' sharing links for each image under --folder-path.
  - Links are made downloadable by appending '?download=1'.
  - It does NOT upload files; it only generates public URLs and writes a manifest.
`;

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  const envKey = `O365_${name.toUpperCase().replace(/-/g, '_')}`;
  return process.env[envKey] || fallback;
}

async function main() {
  if (process.argv.includes('-h') || process.argv.includes('--help')) {
    console.log(help);
    process.exit(0);
  }

  const version = Number(arg('version', '1'));
  const dbUrl = arg('db-url');
  const folderPath = arg('folder-path'); // e.g., /Catalogo/Imagens
  const out = arg('out', 'manifest.json');
  const clientId = arg('client-id', process.env.O365_CLIENT_ID);
  const authority = arg('authority', process.env.O365_AUTHORITY || 'https://login.microsoftonline.com/consumers');
  const scopes = (arg('scopes', process.env.O365_SCOPES || 'Files.Read.All offline_access')).split(/\s+/);

  if (!clientId || !dbUrl || !folderPath) {
    console.error('Missing required flags.');
    console.log(help);
    process.exit(2);
  }

  const pca = new PublicClientApplication({ auth: { clientId, authority } });
  const deviceCodeRequest = {
    scopes: scopes.map(s => (s.includes('/') ? s : `https://graph.microsoft.com/${s}`)),
    deviceCodeCallback: (response) => {
      console.log('\nTo authorize, open:', response.verificationUri);
      console.log('Enter code:', response.userCode);
      console.log('Message:', response.message, '\n');
    }
  };
  const authResponse = await pca.acquireTokenByDeviceCode(deviceCodeRequest);
  const accessToken = authResponse.accessToken;

  async function graph(method, url, body) {
    const res = await fetch(`https://graph.microsoft.com/v1.0${url}`, {
      method,
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}`);
    return await res.json();
  }

  // Resolve folder
  const root = await graph('GET', `/me/drive/root:${encodeURI(folderPath)}`);
  const rootId = root.id;

  const exts = new Set(['.jpg','.jpeg','.png','.webp','.bmp']);
  const items = [];

  async function walk(id, rel) {
    const page = await graph('GET', `/me/drive/items/${id}/children?$top=200`);
    for (const it of page.value || []) {
      if (it.folder) {
        await walk(it.id, path.posix.join(rel, it.name));
      } else {
        const ext = path.extname(it.name).toLowerCase();
        if (ext && exts.has(ext)) {
          items.push({ id: it.id, name: it.name, rel: path.posix.join(rel, it.name) });
        }
      }
    }
  }
  await walk(rootId, '');

  // Helper to create or reuse anonymous share link
  async function ensureShareLink(itemId) {
    try {
      const resp = await graph('POST', `/me/drive/items/${itemId}/createLink`, {
        type: 'view', scope: 'anonymous'
      });
      // Prefer direct download if possible
      let url = resp?.link?.webUrl || resp?.link?.webHtmlLink || resp?.link?.webUrl;
      if (!url) throw new Error('No share URL');
      if (!url.includes('download=')) url += (url.includes('?') ? '&' : '?') + 'download=1';
      return url;
    } catch (e) {
      throw e;
    }
  }

  const files = [];
  for (const it of items) {
    const url = await ensureShareLink(it.id);
    files.push({ file: url });
  }

  const manifest = {
    db: { version, url: dbUrl },
    images: { base_url: '', files }
  };

  await fs.writeFile(out, JSON.stringify(manifest, null, 2));
  console.log(`Manifest written to ${out} with ${files.length} images.`);
}

main().catch((e) => { console.error(e); process.exit(1); });

