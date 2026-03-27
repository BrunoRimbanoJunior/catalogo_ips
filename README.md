# Catálogo IPS

App desktop (Tauri + React) para consulta de peças com sincronização de banco/imagens via manifest. Fluxo de controle de acesso usando Supabase e aprovação manual.

## Como funciona
- Manifest público (`VITE_DEFAULT_MANIFEST_URL`): aponta para o `manifest.json` publicado (asset de release). Contém `appVersion`, `appDownloadUrl`, `db.version/url` e lista de imagens (R2).
- Cliente: ao abrir, lê o manifest, avisa se há nova versão do app, baixa DB/imagens se `db.version` subir e indexa imagens no SQLite local.
- Auth: formulário de cadastro salva no Supabase (`profiles`), status `pending`; admin aprova (service role) e o app libera quando `status=approved`.

## Instalação do cliente
- Baixar na aba Releases do GitHub (tags `v*`).
- **Windows**: `catalogo_ips_x64-setup.exe` (instalador estável) ou `catalogo_ips_*_x64-setup.exe`/`.msi`. Basta executar. Se o SmartScreen avisar, clique em “Mais informações” > “Executar assim mesmo”.
- **macOS**: `catalogo_ips_*_aarch64.dmg` (Apple Silicon) ou `x64.dmg` (Intel). Abra o `.dmg`, arraste para Aplicativos; se o Gatekeeper bloquear, vá em Preferências > Segurança > “Abrir mesmo assim”.
- **Linux**: `catalogo_ips_*_app.tar.gz` (AppImage). Dê permissão de execução (`chmod +x catalogo_ips_*.AppImage`) e rode; dependendo da distro, pode exigir libs GTK/webkit (já empacotadas na maioria das distros). Se usar installer `.deb/.rpm` quando disponível, instale com o gerenciador de pacotes.
- Manifest padrão do app: `https://github.com/BrunoRimbanoJunior/catalogo_ips/releases/latest/download/manifest.json`.

## Desenvolvimento local
Pré-requisitos: Node 20, Rust toolchain, pnpm, Supabase (anon key), manifest público válido.
1) `pnpm install`
2) Configurar `.env.development` (exemplo):
   ```
   VITE_DEFAULT_MANIFEST_URL=https://github.com/BrunoRimbanoJunior/catalogo_ips/releases/latest/download/manifest.json
   VITE_SUPABASE_URL=...
   VITE_SUPABASE_ANON_KEY=...
   VITE_APP_VERSION=dev
   ```
3) Rodar front/Tauri dev: `pnpm dev` e em outro terminal `pnpm tauri dev`.

## Backend de aprovação (FastAPI)
Local (apenas dev) para aprovar cadastros sem expor service role no front:
1) `cd backend`
2) `.env` com `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`
3) `uv venv && uv pip install -r requirements.txt`
4) `uv run uvicorn main:app --reload --port 8000`
5) Painel: `http://localhost:8000/admin`

## Workflows (CI)
- `manifest.yml`: gera `manifest.json` a partir do R2 (usa secrets `R2_*`), insere `appVersion/appDownloadUrl`, comita na `main` (inclusive em tags) e anexa na release.
- `release.yml`: em tags `v*`, alinha versão do Tauri/package com a tag, instala deps (inclui libs GTK para Linux), builda com `tauri-action` e publica instaladores na release.
- `auto-tag.yml`: tagging automática básica (pode ser ajustada conforme a estratégia).

## Geração de manifest manual (dev)
Fluxo suportado: apenas R2.

Comando padrão:
```
pnpm manifest
```

Esse comando:
- usa `scripts/gen-manifest-r2.mjs`;
- lê `.env.development` e `.env` para as credenciais `R2_*`;
- reaproveita `manifest.json` atual se o `data/catalog.db` não mudou;
- calcula `db.sha256` a partir de `data/catalog.db` local quando o arquivo existe;
- usa `MANIFEST_DB_URL` se definido; caso contrário, tenta inferir a URL raw do banco a partir do remote GitHub.

Para forçar versão/URL específicas:
```
pnpm manifest -- --version 25012518 --db-version 25012518 --db-url https://raw.githubusercontent.com/<org>/<repo>/main/data/catalog.db --out manifest.json
```

Para incluir dados de release do app:
```
pnpm manifest -- --app-version 1.5.0 --app-download-url https://github.com/<org>/<repo>/releases/download/v1.5.0/catalogo_ips_x64-setup.exe
```

## Build de release (assinada + updater)
- Gere as chaves uma única vez: `pnpm tauri signer generate` (guarde a `private.key` fora do git; `public.key` fica no `tauri.conf.json`).
- Build local assinada e com `latest.json`: `TAURI_KEY_PASSWORD=*** pnpm tauri:build:signed` (usa `TAURI_PRIVATE_KEY` do ambiente ou o arquivo `./private.key`; defina `TAURI_PRIVATE_KEY_PATH` se estiver em outro lugar).
- Saída: `src-tauri/target/release/bundle/*` com instaladores, `.sig` e `latest.json` para publicar no endpoint configurado no `tauri.conf.json`.
- CI: defina secrets `TAURI_PRIVATE_KEY` (conteúdo do `private.key`) e `TAURI_KEY_PASSWORD` e rode o mesmo comando ou habilite `includeUpdaterJson` no `tauri-action` para anexar o `latest.json` na Release.
- Endpoint default no `tauri.conf.json` usa Releases do GitHub: publique o `latest.json` gerado junto dos instaladores na Release que o updater vai baixar.

## Estrutura do manifest (resumo)
```json
{
  "appVersion": "1.0.1",
  "appDownloadUrl": ".../installer.exe",
  "db": { "version": 25012518, "url": "https://raw.githubusercontent.com/.../data/catalog.db", "sha256": null },
  "images": { "base_url": "https://pub-xxxx.r2.dev/", "files": [ { "file": "7111032801.png", "sha256": "..." } ] }
}
```

## Dicas para produção
- Supabase: RLS ativa na tabela `profiles`, políticas para anon (insert/update/select) e UNIQUE no email. Service role nunca vai para o front.
- Manifest público sempre no asset de release; configure `VITE_DEFAULT_MANIFEST_URL` para esse endereço.
- Releases: use tags `v*` para gerar instaladores e atualizar o manifest com `appVersion` e link de download.
