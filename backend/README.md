> Atualiza??o 2026-09-15: `/auth/register` foi desativado (HTTP 410), pois aceitava cadastro sem autentica??o usando service_role. O app agora usa Supabase Auth e a RPC `register_catalog_profile`; consulte o README principal e aplique a migra??o antes de distribuir. Rotas `/admin/*` continuam exigindo `X-Admin-Token`. As descri??es de cadastro abaixo s?o hist?ricas.

# Backend (FastAPI) para Auth/Cadastro

1. Configure as variáveis no `.env` (copiar `.env.example`):
   - `SUPABASE_URL=https://<projeto>.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY=<service-role>` (não expor ao front)
   - `ADMIN_TOKEN=<token-forte>` (exigido no painel e rotas `/admin*`)
   - `ADMIN_CORS_ORIGINS=http://localhost:8000` (opcional, lista separada por vírgula)
2. Instale dependências:
   ```bash
   uv sync --locked
   ```
3. Rode o servidor local:
   ```bash
   uv run uvicorn main:app --reload --host 0.0.0.0 --port 8000
   ```

### Endpoints
- `GET /health` – teste.
- `POST /auth/register` – cria/atualiza usuário no Supabase Auth (via service role) e faz upsert na tabela `profiles` com status `approved`.

### Tabelas/policies esperadas
- Tabela `profiles` com colunas: `id (uuid PK)`, `status text`, `person_type`, `country`, `state`, `city`, `cpf_cnpj`, `full_name`, `phone_area`, `phone_number`, `email`, `device_fingerprint`, `created_at timestamp`.
- Habilitar RLS:
  - Usuário pode ler/escrever apenas sua linha (`id = auth.uid()`).
  - Admin (role) pode ler todas.

Use o `SERVICE_ROLE_KEY` somente no backend. O front usa apenas `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`. Não exponha o `ADMIN_TOKEN` fora do ambiente administrativo.
