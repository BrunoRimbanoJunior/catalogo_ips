import os
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, EmailStr
from supabase import Client, create_client

app = FastAPI(title="Catalogo IPS - Auth API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

load_dotenv()


def get_supabase() -> Client:
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise HTTPException(status_code=500, detail="Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY")
    return create_client(url, key)


class Registration(BaseModel):
    email: EmailStr
    full_name: str
    person_type: str
    country: str | None = None
    state: str | None = None
    city: str | None = None
    cpf_cnpj: str | None = None
    phone_area: str | None = None
    phone_number: str | None = None
    device_fingerprint: str


class ApproveRequest(BaseModel):
    id: str | None = None
    email: EmailStr | None = None


class BlockRequest(BaseModel):
    id: str | None = None
    email: EmailStr | None = None


class DeleteRequest(BaseModel):
    id: str | None = None
    email: EmailStr | None = None


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/auth/register")
def register(payload: Registration, supabase: Client = Depends(get_supabase)):
    try:
        auth_res = supabase.auth.admin.get_user_by_email(payload.email)
        user_id = auth_res.user.id if auth_res and auth_res.user else None

        if not user_id:
            created = supabase.auth.admin.create_user(
                {"email": payload.email, "email_confirm": True, "email_confirmed_at": None}
            )
            if not created or not created.user:
                raise HTTPException(status_code=400, detail="Falha ao criar usuário no Supabase.")
            user_id = created.user.id

        row = supabase.table("profiles").upsert(
            {
                "id": user_id,
                "email": payload.email,
                "full_name": payload.full_name,
                "person_type": payload.person_type,
                "country": payload.country,
                "state": payload.state,
                "city": payload.city,
                "cpf_cnpj": payload.cpf_cnpj,
                "phone_area": payload.phone_area,
                "phone_number": payload.phone_number,
                "device_fingerprint": payload.device_fingerprint,
                "status": "pending",
            }
        ).execute()

        return {"ok": True, "user_id": user_id, "profile": row.data}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/admin/profiles")
def list_profiles(
    status: str | None = None,
    search: str | None = None,
    supabase: Client = Depends(get_supabase),
):
    try:
        query = supabase.table("profiles").select("*").order("created_at", desc=False)
        if status and status.lower() != "all":
            query = query.eq("status", status)
        if search:
            like = f"%{search}%"
            query = query.or_(
                f"full_name.ilike.{like},email.ilike.{like},cpf_cnpj.ilike.{like},city.ilike.{like}"
            )
        res = query.execute()
        return {"items": res.data or []}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/admin/approve")
def approve(payload: ApproveRequest, supabase: Client = Depends(get_supabase)):
    if not payload.id and not payload.email:
        raise HTTPException(status_code=400, detail="Informe id ou email para aprovar.")
    try:
        query = supabase.table("profiles").update({"status": "approved"})
        if payload.id:
            query = query.eq("id", payload.id)
        if payload.email:
            query = query.eq("email", payload.email)
        res = query.execute()
        return {"ok": True, "updated": res.data}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/admin/block")
def block(payload: BlockRequest, supabase: Client = Depends(get_supabase)):
    if not payload.id and not payload.email:
        raise HTTPException(status_code=400, detail="Informe id ou email para bloquear.")
    try:
        query = supabase.table("profiles").update({"status": "block"})
        if payload.id:
            query = query.eq("id", payload.id)
        if payload.email:
            query = query.eq("email", payload.email)
        res = query.execute()
        return {"ok": True, "updated": res.data}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/admin/delete")
def delete_profile(payload: DeleteRequest, supabase: Client = Depends(get_supabase)):
    if not payload.id and not payload.email:
        raise HTTPException(status_code=400, detail="Informe id ou email para excluir.")
    try:
        user_id = payload.id
        if not user_id and payload.email:
            lookup = supabase.table("profiles").select("id").eq("email", payload.email).maybe_single().execute()
            if lookup.data and lookup.data.get("id"):
                user_id = lookup.data["id"]

        query = supabase.table("profiles").delete()
        if payload.id:
            query = query.eq("id", payload.id)
        if payload.email:
            query = query.eq("email", payload.email)
        res = query.execute()

        if user_id:
            try:
                supabase.auth.admin.delete_user(user_id)
            except Exception:
                pass

        return {"ok": True, "deleted": res.data}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/admin", response_class=HTMLResponse)
def admin_ui():
    return """
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8" />
      <title>Admin - Gestão de cadastros</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 16px; background: #f5f6fa; }
        h1 { margin-bottom: 8px; }
        .status { margin: 8px 0; }
        table { width: 100%; border-collapse: collapse; margin-top: 12px; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
        th { background: #0b4d91; color: #fff; }
        tr:nth-child(even) { background: #f9f9f9; }
        button { padding: 6px 10px; background: #0b4d91; color: #fff; border: none; border-radius: 4px; cursor: pointer; }
        button:hover { background: #093f76; }
        .tag { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 12px; text-transform: capitalize; }
        .pending { background: #fff4e5; color: #8a4b00; }
        .approved { background: #e8fff5; color: #0b6b3a; }
        .block { background: #ffecec; color: #a81b1b; }
        .filters { display: flex; gap: 8px; align-items: center; margin: 8px 0; }
        input, select { padding: 6px 8px; border-radius: 6px; border: 1px solid #ccc; }
        .actions { display: flex; gap: 6px; flex-wrap: wrap; }
        .btn-block { background: #c62828; }
        .btn-delete { background: #5a5a5a; }
      </style>
    </head>
    <body>
      <h1>Gestão de cadastros</h1>
      <div class="filters">
        <label>Status:
          <select id="filter-status">
            <option value="all">Todos</option>
            <option value="pending">Pendentes</option>
            <option value="approved">Aprovados</option>
            <option value="block">Bloqueados</option>
          </select>
        </label>
        <input id="filter-search" placeholder="Buscar (nome, email, CPF/CNPJ, cidade)" />
        <button onclick="load()">Filtrar</button>
      </div>
      <div class="status" id="status">Carregando...</div>
      <table id="tbl">
        <thead>
          <tr>
            <th>Nome</th><th>Email</th><th>CPF/CNPJ</th><th>Cidade</th><th>Status</th><th>Ações</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
      <script>
        async function load() {
          try {
            const status = document.getElementById('filter-status').value;
            const search = document.getElementById('filter-search').value;
            const params = new URLSearchParams();
            if (status && status !== 'all') params.set('status', status);
            if (search) params.set('search', search);
            const res = await fetch('/admin/profiles?' + params.toString());
            const json = await res.json();
            if (!res.ok) throw new Error(json.detail || res.statusText);
            document.getElementById('status').textContent = 'Total: ' + (json.items?.length || 0);
            const tbody = document.querySelector('#tbl tbody');
            tbody.innerHTML = '';
            (json.items || []).forEach(p => {
              const tr = document.createElement('tr');
              tr.innerHTML = `
                <td>${p.full_name || '-'}</td>
                <td>${p.email || '-'}</td>
                <td>${p.cpf_cnpj || '-'}</td>
                <td>${p.city || '-'}</td>
                <td><span class="tag ${p.status || ''}">${p.status || ''}</span></td>
                <td class="actions">
                  <button data-id="${p.id}" data-action="approve">Aprovar</button>
                  <button class="btn-block" data-id="${p.id}" data-action="block">Bloquear</button>
                  <button class="btn-delete" data-id="${p.id}" data-action="delete">Excluir</button>
                </td>
              `;
              tr.querySelectorAll('button').forEach(btn => {
                btn.onclick = async () => {
                  const action = btn.getAttribute('data-action');
                  const endpoint = action === 'approve' ? '/admin/approve' : action === 'block' ? '/admin/block' : '/admin/delete';
                  if (action === 'delete' && !confirm('Confirmar exclusão?')) return;
                  const r = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: p.id })
                  });
                  if (r.ok) { load(); } else { alert('Erro na ação: ' + action); }
                };
              });
              tbody.appendChild(tr);
            });
          } catch (e) {
            document.getElementById('status').textContent = 'Erro: ' + e.message;
            console.error(e);
          }
        }
        load();
      </script>
    </body>
    </html>
    """
