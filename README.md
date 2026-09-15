# Catálogo IPS

App desktop (Tauri + React) para consulta de peças com sincronização de banco/imagens via manifest. Fluxo de controle de acessos, e exibição de imagens e itens em lançamento.

## Como funciona
- Manifest público (`VITE_DEFAULT_MANIFEST_URL`): aponta para `manifest.json` na branch `main`. Contém `appVersion`, `appDownloadUrl`, `db.version/url` e lista de imagens (R2).
- Cliente: ao abrir, lê o manifest, avisa se há nova versão do app, baixa DB/imagens se `db.version` subir e indexa imagens no SQLite local.
- Auth: formulário de cadastro salva no banco (`profiles`), o status pode ser 'aprovado', 'cancelado'.

## Instalação do cliente
- Baixar na aba Releases do GitHub (tags `v*`).
- **Windows**: `catalogo_ips_x64-setup.exe` (instalador estável) ou `catalogo_ips_*_x64-setup.exe`/`.msi`. Basta executar. Se o SmartScreen avisar, clique em “Mais informações” > “Executar assim mesmo”.
- **macOS**: `catalogo_ips_*_aarch64.dmg` (Apple Silicon) ou `x64.dmg` (Intel). Abra o `.dmg`, arraste para Aplicativos; se o Gatekeeper bloquear, vá em Preferências > Segurança > “Abrir mesmo assim”.
- **Linux**: `catalogo_ips_*_app.tar.gz` (AppImage). Dê permissão de execução (`chmod +x catalogo_ips_*.AppImage`) e rode; dependendo da distro, pode exigir libs GTK/webkit (já empacotadas na maioria das distros). Se usar installer `.deb/.rpm` quando disponível, instale com o gerenciador de pacotes.
- Manifest padrão do app: `https://raw.githubusercontent.com/BrunoRimbanoJunior/catalogo_ips/main/manifest.json`.

## Desenvolvimento local
Pré-requisitos: Node 20, Rust toolchain, pnpm, Supabase (anon key), manifest público válido.
1) `pnpm install --frozen-lockfile`
2) Configurar `.env.development` (exemplo):
   ```
   VITE_DEFAULT_MANIFEST_URL=https://raw.githubusercontent.com/BrunoRimbanoJunior/catalogo_ips/main/manifest.json
   VITE_SUPABASE_URL=...
   VITE_SUPABASE_ANON_KEY=...
   VITE_APP_VERSION=dev
   ```
3) Rodar front/Tauri dev: `pnpm dev` e em outro terminal `pnpm tauri dev`.

## Backend administrativo (FastAPI)
Local (apenas dev) para gerenciar cadastros sem expor service role no front:
1) `cd backend`
2) `.env` com `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e `ADMIN_TOKEN`
3) `cd backend && uv sync --locked`
4) `uv run uvicorn main:app --reload --port 8000`
5) Painel: `http://localhost:8000/admin` (informe o `ADMIN_TOKEN` quando solicitado)

## Workflows (CI)
- `manifest.yml`: gera o manifest, prende `db.url` ao commit validado, confere hash/SQLite/versão local e remotamente e só então comita na `main`. Em tags, anexa uma cópia à release para auditoria.
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
- lê `meta.db_version` de `data/catalog.db` para preencher `db.version`, igual ao workflow;
- reaproveita `manifest.json` atual se o `data/catalog.db` não mudou;
- calcula `db.sha256` a partir de `data/catalog.db` local quando o arquivo existe;
- usa a versão do `package.json` para preencher `appVersion/appDownloadUrl` quando não houver sobrescrita;
- usa `MANIFEST_DB_URL` se definido; caso contrário, tenta inferir a URL raw do banco a partir do remote GitHub.

Para forçar versão/URL específicas:
```
pnpm manifest -- --version 25012518 --db-version 25012518 --db-url https://raw.githubusercontent.com/<org>/<repo>/<commit-sha>/data/catalog.db --out manifest.json
```

Para sobrescrever os dados de release do app:
```
pnpm manifest -- --app-version 1.5.0 --app-download-url https://github.com/<org>/<repo>/releases/download/v1.5.0/catalogo_ips_x64-setup.exe
```

## Build de release (assinada + updater)
- Gere as chaves uma única vez: `pnpm tauri signer generate` (guarde a `private.key` fora do git; `public.key` fica no `tauri.conf.json`).
- Build local assinada e com artefatos de updater: `TAURI_SIGNING_PRIVATE_KEY_PATH=./private.key TAURI_SIGNING_PRIVATE_KEY_PASSWORD=*** pnpm tauri:build:signed`.
- No Windows/local, você pode colocar `TAURI_SIGNING_PRIVATE_KEY_PATH` e `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` em `.env.local` ou `.env.development` e rodar `pnpm tauri:build:signed`; não coloque a chave privada em `.env.production`.
- Saída: `src-tauri/target/release/bundle/*` com instaladores, bundles de updater e arquivos `.sig`.
- CI: defina secrets `TAURI_PRIVATE_KEY` (conteúdo do `private.key`) e `TAURI_KEY_PASSWORD` e rode o mesmo comando ou habilite `includeUpdaterJson` no `tauri-action` para anexar o `latest.json` na Release.
- Endpoint default no `tauri.conf.json` usa Releases do GitHub: o app consulta `https://github.com/BrunoRimbanoJunior/catalogo_ips/releases/latest/download/latest.json`.
- Para publicar update: crie uma tag SemVer `vX.Y.Z`, envie ao GitHub e aguarde o workflow `release`; o `tauri-action` publica instaladores, assinaturas e `latest.json`.

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
- O app consome o manifest estável da `main`; não use o asset `releases/latest/download/manifest.json`, pois ele fica congelado até outra release.
- Antes de publicar manualmente, rode `pnpm manifest:validate`.
- Para conferir se o lockfile pnpm pode ser deduplicado, rode `pnpm deps:check`.
- Para remover artefatos locais do Rust/Tauri, rode `pnpm clean:rust`.
- Releases: use tags `v*` para gerar instaladores e atualizar o manifest com `appVersion` e link de download.


## Cadastro autenticado e troca de m?quina (2026-09-15)

Antes de distribuir esta vers?o:

1. Execute `supabase/migrations/20260915_authenticated_registration.sql` no SQL Editor do projeto correto. Requer a tabela existente `profiles`, incluindo `user_id uuid`, `id` com default e a pol?tica de SELECT do pr?prio usu?rio (`user_id = auth.uid()`). A migra??o aborta se houver e-mails duplicados sem diferenciar mai?sculas/min?sculas; examine essas linhas antes de resolver duplicidades manualmente.
2. Em Authentication, habilite login/cadastro por e-mail e configure o template de Magic Link para incluir `{{ .Token }}` (ex.: `<p>Seu c?digo: {{ .Token }}</p>`). Confira tamb?m o template de confirma??o de cadastro caso usado pelo projeto. O cliente usa `signInWithOtp` e `verifyOtp` com tipo `email`, sem depender de links que abrem outro navegador.
3. Configure SMTP para os destinat?rios de produ??o e valide entrega, expira??o, limites de envio e eventuais requisitos de CAPTCHA. Nenhum e-mail foi enviado durante o desenvolvimento.
4. Gere e distribua um novo instalador. Vers?es antigas que gravam diretamente na tabela precisam ser atualizadas.

A fun??o usa o e-mail da sess?o, nunca o e-mail/status/user_id fornecido pelo cliente. Vincula cadastros antigos com `user_id` vazio somente ao titular autenticado do e-mail, preserva status e dispositivo e aprova apenas cadastros novos. A migra??o retira INSERT/UPDATE/DELETE diretos de `authenticated`: as pol?ticas existentes continuam, mas grava??es passam pela fun??o. Revise outros clientes que dependam de grava??o direta antes de aplicar.

Troca de m?quina: localize o cadastro por e-mail no painel administrativo e limpe `device_fingerprint` (NULL). O titular confirma o mesmo e-mail no novo app e envia a ficha novamente. A fun??o vincula o dispositivo novo somente se o campo estiver vazio. O fingerprint identifica a instala??o/navegador, n?o ? uma identifica??o f?sica inviol?vel.

O cliente inicia sem confiar no antigo `profile.cached`, consulta apenas `user_id` da sess?o e revalida a cada 60 segundos. Sem valida??o online, o acesso fica bloqueado; isso muda o comportamento offline anterior. O modo de desenvolvimento mant?m o bypass existente. Dados do cat?logo j? baixados no computador n?o podem ser protegidos apenas por uma tela de bloqueio.

### Valida??o antes da publica??o

- Novo e-mail: envio de c?digo, rejei??o de c?digo incorreto/expirado, confirma??o, cadastro com `user_id` correto.
- E-mail legado: recupera??o do mesmo ID sem duplicar linha; bloqueado continua bloqueado.
- Outra m?quina: recusa at? limpar o dispositivo; ap?s reset e reenvio, novo fingerprint vinculado e m?quina antiga bloqueada na revalida??o.
- Sess?o ausente/expirada, exclus?o de perfil, indisponibilidade da API: cache antigo n?o libera acesso.
- Usu?rio A n?o l? o perfil B; grava??o direta e chamada an?nima da RPC s?o recusadas; campos de status/identidade enviados ? RPC n?o alteram a decis?o do servidor.

Refer?ncia: https://supabase.com/docs/guides/auth/auth-email-passwordless


## Dois dispositivos por conta (substitui as instrucoes anteriores de dispositivo)

Desktop e mobile agora usam `register_catalog_profile` para salvar e `get_catalog_profile` para consultar. O limite e de DOIS dispositivos totais por e-mail (PC + celular, ou outra combinacao). Reabrir no mesmo dispositivo nao consome vaga. O terceiro recebe erro; status bloqueado permanece bloqueado.

### Ativacao

1. No banco compartilhado, aplique UMA VEZ `supabase/migrations/20260916_two_devices.sql`, depois da migracao de cadastro autenticado ja aplicada. O SQL e identico nos dois repositorios.
2. Distribua ambos os clientes atualizados. A migracao revoga novamente as gravacoes diretas, inclusive a permissao temporaria do mobile antigo. Versoes anteriores devem ser atualizadas.
3. O template OTP/SMTP existente continua sendo usado. Nao e necessario criar outro projeto Supabase.

`profile_devices` armazena `user_id`, `fingerprint` e `created_at`. O dispositivo antigo e importado automaticamente, e `profiles.device_fingerprint` e esvaziado depois da importacao. Perfis legados sem `user_id` sao vinculados e importados apos confirmar o e-mail. Agora limpar o campo antigo NAO libera uma vaga.

### Remover um dispositivo antigo (administrador)

Primeiro consulte pelo e-mail no SQL Editor:

```sql
SELECT p.email, d.user_id, d.fingerprint, d.created_at
FROM public.profiles p
JOIN public.profile_devices d ON d.user_id = p.user_id
WHERE lower(p.email) = lower('EMAIL_DO_USUARIO')
ORDER BY d.created_at;
```

Apos identificar o vinculo correto, remova SOMENTE essa linha de `profile_devices` no Table Editor (filtre por user_id e fingerprint). Preserve `profiles` e `auth.users`. O novo dispositivo pode entao enviar a ficha. A consulta periodica dos apps valida autorizacao a cada 60 segundos; ela nao reinscreve dispositivos removidos. Sem validacao online, o acesso nao e garantido. O modo de desenvolvimento conserva seu bypass de acesso.

### Validacao local

Build frontend: `pnpm build`. No desktop, `node --test tests/registration.test.mjs` testa o envio/confirmacao de OTP com rede simulada.
O teste `tests/two-devices.integration.mjs` do desktop executa as migracoes em PostgreSQL embarcado (PGlite), com Auth simulado: legado, duas vagas, terceira recusada, repeticao, remocao/substituicao, bloqueio, isolamento e permissoes. Preparacao: `npm install --prefix tmp/device-tests --no-audit --no-fund @electric-sql/pglite`; execucao: `node tests/two-devices.integration.mjs`. Chamadas concorrentes sao serializadas pelo PGlite; concorrencia entre sessoes reais ainda deve ser validada no Supabase de teste.
