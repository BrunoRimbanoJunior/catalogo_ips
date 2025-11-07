# Catálogo IPS — Tauri + React + SQLite

Aplicativo desktop de catálogo com filtros por fabricante, grupo e veículo; busca por código (produto/OEM/Similar/Veículo); detalhes com “Compatível com”, “Detalhes” e “Similares”. Banco local SQLite e sincronização de base e imagens via manifest hospedado (Git/R2).

## Funcionalidades

- Filtros: Fabricante (chips), Grupo e Veículo (selects), e busca por código (produto/OEM/Similar/Veículo).
- Detalhes do item: código, descrição, marca, compatibilidade, detalhes e similares. Galeria com visualização ampliada ao clique (lightbox).
- Sincronização do cliente: em cada inicialização, o app resolve a URL do manifest.json, baixa o DB se versão maior e baixa imagens faltantes. Em seguida indexa imagens no DB.
- Branding versionado: logo e fundo em public/images/ (definidos nas Ferramentas em Dev) são empacotados no build.
- Ferramentas (somente Dev): Verificar atualizações (manifest padrão), Indexar via manifest, Importar Excel, Exportar DB, Exportar DB + Manifest (R2), Abrir dados/imagens/DB, Limpar manifest salvo.

## Estrutura do banco (resumo)

- Tabelas: rands, ehicles, products (campos principais: brand_id, code, description, application, details, oem, similar, pgroup), product_vehicles, images, meta (key=db_version).
- meta.db_version identifica a versão do DB local; importações incrementam automaticamente.

## Manifest (DB + imagens)

Exemplo de manifest.json:

`
{
  "db": { "version": 3, "url": "https://raw.githubusercontent.com/<user>/<repo>/main/data/catalog.db", "sha256": null },
  "images": {
    "base_url": "https://pub-xxxxxxxxxxxxxxxx.r2.dev/",
    "files": [ { "file": "7111032801.png", "sha256": null } ]
  }
}
`

Observações:
- Use a “Public Development URL” do bucket no R2 como ase_url (ex.: https://pub-…r2.dev/, com / no final). Não use o endpoint S3 da conta (…cloudflarestorage.com), pois retorna 400 para público.
- iles[].file deve conter o caminho/nome relativo dentro do bucket.

## Desenvolvimento (Dev)

Pré‑requisitos:
- Node 20+, Rust (toolchain stable), Tauri (instala automaticamente via CLI), PNPM ou NPM.

Passos:
1) Instale dependências: pnpm install (ou 
pm i)
2) (Recomendado) crie .env.development na raiz com:
   - VITE_DEFAULT_MANIFEST_URL=http://localhost:1420/manifest.json
3) Rode o front e o shell do Tauri em terminais separados:
   - pnpm dev
   - pnpm tauri dev
4) Ferramentas (Dev): clique em “Limpar manifest salvo” para garantir uso do padrão; depois “Verificar atualizações (manifest padrão)”.
5) Selecione um produto e clique na miniatura para abrir a visualização ampliada.

Notas de Dev (imagens):
- Em desenvolvimento, as miniaturas e o preview usam data URLs (base64) geradas a partir dos arquivos baixados (garante render mesmo quando o scheme sset:// do WebView não está ativo no Dev).

## Importação do Excel

Layout suportado:
- CODIGO | GRUPO | DESCRIÇÃO | MONTADORA | APLICAÇÃO | MARCA | OEM | SIMILAR

Mapeamento (case/acentos indiferentes):
- CODIGO → products.code (chave de upsert)
- GRUPO/GRUPO DE PRODUTOS/CATEGORIA → products.pgroup
- DESCRIÇÃO → products.description
- MARCA/FABRICANTE → tabela rands + products.brand_id
- APLICAÇÃO → vincula veículos (texto é dividido e indexado em ehicles + product_vehicles)
- OEM, SIMILAR → products.oem, products.similar
- MONTADORA é ignorada no import (veículos vêm de APLICAÇÃO)
- Ignorados: ANO, LINK, FOTO/FOTOS (se existirem)

O import faz upsert por products.code e incrementa meta.db_version automaticamente.

## Geração de manifest (R2)

Pelo próprio app (Dev):
- Ferramentas → “Exportar DB + Manifest (R2)”.
- Preencha “Credenciais R2 / Config Manifest” (com tooltips):
  - Account ID, Bucket (ex.: ipsimages), Access Key ID, Secret Access Key
  - Public Base URL: https://pub-…r2.dev/
  - DB URL (raw Git): URL completa do data/catalog.db no GitHub
- O app executa scripts/gen-manifest-r2.mjs localmente e grava o manifest.json no caminho escolhido.

Via CLI (alternativa):
`
R2_ACCOUNT_ID=... \
R2_BUCKET=ipsimages \
R2_ACCESS_KEY_ID=... \
R2_SECRET_ACCESS_KEY=... \
R2_PUBLIC_BASE_URL=https://pub-...r2.dev/ \
node scripts/gen-manifest-r2.mjs --version 3 --db-url https://raw.githubusercontent.com/<user>/<repo>/main/data/catalog.db --out manifest.json
`

## Build local (Windows)

Opção 1 (manual):
- .env.production com a URL padrão do manifest (Git raw):
  - VITE_DEFAULT_MANIFEST_URL=https://raw.githubusercontent.com/<user>/<repo>/main/manifest.json
- Build front: pnpm build
- Build app: pnpm tauri build
- Saída: src-tauri/target/release/bundle/

Opção 2 (script):
- ./scripts/build-local.ps1 -ManifestUrl "https://raw.githubusercontent.com/<user>/<repo>/main/manifest.json"

## Comportamento do cliente (produção)

- Ao iniciar, o app resolve a URL do manifest (LocalStorage → VITE_DEFAULT_MANIFEST_URL → fallback Git) e executa:
  1) sync_from_manifest: baixa DB novo (se db.version maior) e imagens faltantes.
  2) index_images_from_manifest: indexa os nomes das imagens no DB para cada produto.
- Imagens são salvas em:
  - Windows: %LOCALAPPDATA%/com.jubar.catalogo-ips/images

## Troubleshooting rápido

- 400 ao baixar imagens: verifique images.base_url no manifest.json. Precisa ser a Public Development URL do bucket (https://pub-…r2.dev/), com / final.
- Manifest “antigo” carregado: use “Limpar manifest salvo” (remove LocalStorage) e reinicie.
- Dev não mostra imagens: em Dev usamos data URLs (base64) via ead_image_base64 — se ainda assim não aparecer, confirme se o arquivo existe na pasta de imagens e se o nome em selected.images bate com o arquivo.

## Comandos Tauri expostos

- init_app — prepara diretórios e banco, retorna paths e versão local.
- get_brands_cmd, get_groups_cmd, get_vehicles_cmd, get_vehicles_filtered_cmd, get_makes_cmd, get_vehicles_by_make_cmd
- search_products_cmd — filtros (marca/grupo/veículo) + busca por código/OEM/Similar e também por veículo.
- get_product_details_cmd — dados + imagens, inclui similar.
- sync_from_manifest — baixa DB e imagens conforme manifest.
- index_images_from_manifest — indexa nomes de imagens conforme manifest.
- import_excel(path) — importa/atualiza DB via XLSX.
- index_images(root) — (Dev/legado) varre pasta local e indexa por código do arquivo.
- export_db_to(dest_path) — exporta o DB compactado (VACUUM INTO).
- set_branding_image(kind, source_path) — copia logo/fundo para public/images/.
- gen_manifest_r2(version, db_url, out_path, r2) — gera manifest.json listando objetos no bucket R2 (S3 API).
- ead_image_base64(path_or_rel) — lê a imagem local e retorna data:image/...;base64,... (útil no Dev).

---

Se precisar, posso adicionar índices SQL (em migrations) para acelerar buscas por products.code, products.oem, products.similar e ehicles.name.

## Manutenção (atualização de base e imagens)

1) Importe o Excel (Ferramentas → Importar Excel) para atualizar/incluir produtos. O db_version local será incrementado.
2) Exporte o DB e gere o manifest do R2 (Ferramentas → Exportar DB + Manifest (R2)).
   - Preencha/atualize as credenciais R2 e a Public Base URL (https://pub-…r2.dev/).
   - O script usa um número de versão (padrão: timestamp) no campo db.version do manifest.
3) Faça commit de data/catalog.db (se aplicável) e do manifest.json no repositório Git.
4) Clientes: ao abrir, verificam a versão no manifest e baixam DB/imagens novos automaticamente.

Observação: se desejar forçar a verificação em produção sem reiniciar o app, implemente no front um botão de “Verificar atualizações” (no cliente não expomos as Ferramentas Dev por padrão).
