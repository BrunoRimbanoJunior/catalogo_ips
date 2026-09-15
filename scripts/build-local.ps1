Param(
  [string]$ManifestUrl = "https://raw.githubusercontent.com/BrunoRimbanoJunior/catalogo_ips/main/manifest.json"
)

Write-Host "==> Preparando ambiente (Node deps)" -ForegroundColor Cyan
npm i

Write-Host "==> Configurando manifest para este build" -ForegroundColor Cyan
# Keep .env.production intact: it also contains the public Supabase configuration.
$previousManifestUrl = $env:VITE_DEFAULT_MANIFEST_URL
$env:VITE_DEFAULT_MANIFEST_URL = $ManifestUrl
try {

Write-Host "==> Build frontend (Vite)" -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { throw "Falha no build do frontend" }

Write-Host "==> Build app (Tauri)" -ForegroundColor Cyan
$env:RUST_BACKTRACE = "1"
npx tauri build --verbose
if ($LASTEXITCODE -ne 0) { throw "Falha no build do Tauri" }

Write-Host "==> Concluído. Bundles em src-tauri/target/release/bundle" -ForegroundColor Green
} finally {
  $env:VITE_DEFAULT_MANIFEST_URL = $previousManifestUrl
}

