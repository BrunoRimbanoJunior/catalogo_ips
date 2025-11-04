# CatÃ¡logo IPS â€” Tauri + React + SQLite

App desktop de catÃ¡logo com filtros por fabricante, descriÃ§Ã£o e veÃ­culo. Banco local SQLite e sincronizaÃ§Ã£o de base e imagens via manifest hospedado (Git/OneDrive).

## Rodando em desenvolvimento

- PrÃ©â€‘requisitos: Node 18+, pnpm, Rust (toolchain stable), Tauri CLI.
- Comandos:
  - `pnpm install`
  - `pnpm tauri dev`

## Manifest (atualizaÃ§Ã£o de banco e imagens)

Publique um arquivo `manifest.json` acessÃ­vel por HTTP (ex.: Git raw). Exemplo em `public/manifest.sample.json`:

```
{
  "db": { "version": 3, "url": "https://.../catalog.db" },
  "images": {
    "base_url": "https://onedrive-public-url/imagens/",
    "files": [ { "file": "ABC123.jpg" } ]
  }
}
```

No app, informe a URL do manifest e clique “Verificar atualizações”. O app salva a última URL e, ao abrir, executa automaticamente sincronização do banco e indexação de imagens a partir do manifest salvo.

### Gerar manifest a partir de uma pasta de imagens

- Gere o DB localmente (via Importar Excel na UI) e depois exporte uma cÃ³pia compacta para o repositÃ³rio:
  - Pela UI, chame o comando `export_db_to` (jÃ¡ exposto como API; posso colocar um botÃ£o se quiser) ou copie o DB de `init_app.db_path` para `data/catalog.db`.
- Coloque as imagens pÃºblicas em `images/` dentro do repo (ou use outra pasta e ajuste os parÃ¢metros).
- Rode:
  - `pnpm manifest -- --version 3 --db-url https://raw.githubusercontent.com/<user>/<repo>/main/data/catalog.db --images-base-url https://raw.githubusercontent.com/<user>/<repo>/main/images/ --images-dir images --out manifest.json`
- FaÃ§a commit de `data/catalog.db`, da pasta `images/` e do `manifest.json` no Git. A URL Raw do `manifest.json` serÃ¡ usada no app do cliente.

### Gerar manifest com OneDrive (links pÃºblicos)

- PrÃ©-requisito: um App do Azure AD (public client) com permissÃµes Delegadas Microsoft Graph: `Files.Read.All` e `offline_access`. Copie o `Application (client) ID`.
- AutenticaÃ§Ã£o: Device Code (o script mostra uma URL e um cÃ³digo para vocÃª entrar com sua conta do OneDrive).
- Comando:
  - `O365_CLIENT_ID=<seu_client_id> pnpm manifest:onedrive -- --version 3 --db-url https://raw.githubusercontent.com/<user>/<repo>/main/data/catalog.db --folder-path /Catalogo/Imagens --out manifest.json`
- O script cria links de compartilhamento anÃ´nimos (view) e grava cada imagem como URL completa no `manifest.json` (forÃ§ando download com `?download=1`).
- ObservaÃ§Ã£o: se preferir nÃ£o usar OneDrive, utilize a estratÃ©gia â€œbase_url + arquivos relativosâ€ com um hosting estÃ¡tico (GitHub/S3/R2/etc.).

## Estrutura do banco

- `brands`, `vehicles`, `products(oem, similar)`, `product_vehicles`, `images` e `meta(key=db_version)`.

## ImportaÃ§Ã£o do Excel

- Novo layout suportado (ordem tÃ­pica):
  - `CODIGO | GRUPO | DESCRIÃ‡ÃƒO | MONTADORA | APLICAÃ‡ÃƒO | MARCA | OEM | SIMILAR`
- Mapeamento (case/acentos indiferentes):
  - `CODIGO` â†’ `products.code` (chave de upsert)
  - `GRUPO`/`GRUPO DE PRODUTOS`/`CATEGORIA` â†’ `products.pgroup`
  - `DESCRIÃ‡ÃƒO` â†’ `products.description`
  - `MARCA`/`FABRICANTE` â†’ tabela `brands` + `products.brand_id`
  - `APLICAÃ‡ÃƒO` â†’ usada para vincular veÃ­culos; o texto Ã© dividido e indexado em `vehicles` + `product_vehicles`
  - `OEM`, `SIMILAR` â†’ `products.oem`, `products.similar`
  - `MONTADORA` Ã© ignorada no import (os veÃ­culos vÃªm de `APLICAÃ‡ÃƒO`)
- Ignorados: `ANO`, `LINK`, `FOTO/FOTOS` (se existirem)
- O import faz upsert por `products.code` e incrementa `db_version`.

## Comandos Tauri expostos

- `init_app` â€” prepara diretÃ³rios e banco, retorna versÃ£o local.
- `get_brands_cmd`, `get_vehicles_cmd`
- `search_products_cmd` â€” filtros por marca/veÃ­culo e texto.
- `get_product_details_cmd` â€” dados + nomes de arquivos de imagem.
- `sync_from_manifest` â€” baixa DB e imagens conforme manifest.
- `import_excel(path)` â€” importa/atualiza DB via XLSX.
- `index_images(root)` â€” mapeia imagens por cÃ³digo do produto.
- `export_db_to(dest_path)` â€” exporta o DB compactado (VACUUM INTO).

## Build e instalador (Windows)

- Build release: `pnpm tauri build`.
- SaÃ­da: `src-tauri/target/release/bundle/` (EXE/NSIS installer). O projeto estÃ¡ configurado para usar NSIS, que costuma gerar o instalador mais leve.


