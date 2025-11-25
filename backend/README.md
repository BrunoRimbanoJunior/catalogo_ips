# Backend (FastAPI) para Auth/Cadastro

1. Configure as variáveis no `.env` (copiar `.env.example`):
   - `SUPABASE_URL=https://<projeto>.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY=<service-role>` (não expor ao front)
2. Instale dependências:
   ```bash
   pip install -r requirements.txt
   ```
3. Rode o servidor local:
   ```bash
   uvicorn main:app --reload --host 0.0.0.0 --port 8000
   ```

### Endpoints
- `GET /health` – teste.
- `POST /auth/register` – cria/atualiza usuário no Supabase Auth (via service role) e faz upsert na tabela `profiles` com status `pending`.

### Tabelas/policies esperadas
- Tabela `profiles` com colunas: `id (uuid PK)`, `status text`, `person_type`, `country`, `state`, `city`, `cpf_cnpj`, `full_name`, `phone_area`, `phone_number`, `email`, `device_fingerprint`, `created_at timestamp`.
- Habilitar RLS:
  - Usuário pode ler/escrever apenas sua linha (`id = auth.uid()`).
  - Admin (role) pode ler todas.

Use o `SERVICE_ROLE_KEY` somente no backend. O front usa apenas `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`.
