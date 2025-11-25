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
def list_profiles(status: str | None = None, supabase: Client = Depends(get_supabase)):
    try:
        query = supabase.table("profiles").select("*").order("created_at", desc=False)
        if status:
            query = query.eq("status", status)
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


@app.get("/admin", response_class=HTMLResponse)
def admin_ui():
    return """
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8" />
      <title>Admin - Aprovar cadastros</title>
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
        .tag { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
        .pending { background: #fff4e5; color: #8a4b00; }
        .approved { background: #e8fff5; color: #0b6b3a; }
      </style>
    </head>
    <body>
      <h1>Aprovação de cadastros (dev)</h1>
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
            const res = await fetch('/admin/profiles?status=pending');
            const json = await res.json();
            if (!res.ok) throw new Error(json.detail || res.statusText);
            document.getElementById('status').textContent = 'Pendentes: ' + (json.items?.length || 0);
            const tbody = document.querySelector('#tbl tbody');
            tbody.innerHTML = '';
            (json.items || []).forEach(p => {
              const tr = document.createElement('tr');
              tr.innerHTML = `
                <td>${p.full_name || '-'}</td>
                <td>${p.email || '-'}</td>
                <td>${p.cpf_cnpj || '-'}</td>
                <td>${p.city || '-'}</td>
                <td><span class="tag pending">${p.status || ''}</span></td>
                <td><button data-id="${p.id}">Aprovar</button></td>
              `;
              tr.querySelector('button').onclick = async () => {
                const r = await fetch('/admin/approve', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ id: p.id })
                });
                if (r.ok) { load(); } else { alert('Erro ao aprovar'); }
              };
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
