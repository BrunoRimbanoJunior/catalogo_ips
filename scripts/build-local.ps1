Param(
  [string]$ManifestUrl = "https://raw.githubusercontent.com/BrunoRimbanoJunior/catalogo_ips/main/manifest.json"
)

Write-Host "==> Preparando ambiente (Node deps)" -ForegroundColor Cyan
npm i

Write-Host "==> Gravando .env.production" -ForegroundColor Cyan
"VITE_DEFAULT_MANIFEST_URL=$ManifestUrl" | Out-File -FilePath .env.production -Encoding utf8

Write-Host "==> Build frontend (Vite)" -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { throw "Falha no build do frontend" }

Write-Host "==> Build app (Tauri)" -ForegroundColor Cyan
$env:RUST_BACKTRACE = "1"
npx tauri build --verbose
if ($LASTEXITCODE -ne 0) { throw "Falha no build do Tauri" }

Write-Host "==> Concluído. Bundles em src-tauri/target/release/bundle" -ForegroundColor Green

