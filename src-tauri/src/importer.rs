use crate::db::{ensure_dirs, open_db};
use anyhow::Result;
use calamine::{open_workbook_auto, Reader};
use rusqlite::{params, OptionalExtension};
use tauri::AppHandle;

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct ImportResult {
    pub processed_rows: usize,
    pub upserted_products: usize,
    pub linked_vehicles: usize,
    pub new_db_version: i64,
}

/// Calcula candidato de cabeçalho normalizado
fn norm(s: &str) -> String {
    let s = s.trim();
    let up = s.to_ascii_uppercase();
    up.chars()
        .map(|c| match c {
            'Á' | 'À' | 'Ã' | 'Â' | 'Ä' => 'A',
            'É' | 'È' | 'Ê' | 'Ë' => 'E',
            'Í' | 'Ì' | 'Î' | 'Ï' => 'I',
            'Ó' | 'Ò' | 'Õ' | 'Ô' | 'Ö' => 'O',
            'Ú' | 'Ù' | 'Û' | 'Ü' => 'U',
            'Ç' => 'C',
            other => other,
        })
        .collect()
}

fn header_key(s: &str) -> &'static str {
    let n = norm(s);
    if ["FABRICANTE", "MARCA"].contains(&n.as_str()) {
        "brand"
    } else if ["CODIGO", "CÓDIGO", "COD", "REFERENCIA", "REF"].contains(&n.as_str()) {
        "code"
    } else if ["DESCRICAO", "DESCRIÇÃO"].contains(&n.as_str()) {
        "description"
    } else if ["GRUPO", "GRUPO DE PRODUTOS", "CATEGORIA"].contains(&n.as_str()) {
        "group"
    } else if ["APLICACAO", "APLICAÇÃO"].contains(&n.as_str()) {
        "application"
    } else if ["MONTADORA", "MONTADORA/S"].contains(&n.as_str()) {
        "make"
    } else if ["OEM"].contains(&n.as_str()) {
        "oem"
    } else if ["SIMILAR"].contains(&n.as_str()) {
        "similar"
    } else {
        "ignore"
    }
}

pub fn import_excel(app: AppHandle, path: String) -> Result<ImportResult, String> {
    let (_, dbf, _) = ensure_dirs(&app).map_err(|e| e.to_string())?;
    let mut wb = open_workbook_auto(&path).map_err(|e| format!("Falha abrindo XLSX: {e}"))?;
    let sheet_names = wb.sheet_names().to_vec();
    let sheet = sheet_names
        .get(0)
        .ok_or_else(|| "Planilha vazia".to_string())?
        .to_string();
    let range = wb.worksheet_range(&sheet).map_err(|e| e.to_string())?;

    let mut rows = range.rows();
    let header = rows.next().ok_or("XLSX sem cabecalho")?;
    let mut idx = (
        usize::MAX,
        usize::MAX,
        usize::MAX,
        usize::MAX,
        usize::MAX,
        usize::MAX,
        usize::MAX,
        usize::MAX,
    );
    let mut idx_details: usize = usize::MAX;
    let mut idx_make: usize = usize::MAX;
    // order: brand, code, description, group, application, vehicles, oem, similar
    for (i, cell) in header.iter().enumerate() {
        let key = header_key(&cell.to_string());
        match key {
            "brand" if idx.0 == usize::MAX => idx.0 = i,
            "code" if idx.1 == usize::MAX => idx.1 = i,
            "description" if idx.2 == usize::MAX => idx.2 = i,
            "group" if idx.3 == usize::MAX => idx.3 = i,
            "application" if idx.4 == usize::MAX => idx.4 = i,
            "vehicles" if idx.5 == usize::MAX => idx.5 = i,
            "oem" if idx.6 == usize::MAX => idx.6 = i,
            "similar" if idx.7 == usize::MAX => idx.7 = i,
            "make" if idx_make == usize::MAX => idx_make = i,
            _ => {}
        }
        let t = cell.to_string().to_ascii_uppercase();
        if idx_details == usize::MAX && (t.contains("DETAL") || t.contains("OBSERV") || t == "OBS" || t.contains("NOTA")) {
            idx_details = i;
        }
    }
    if idx.1 == usize::MAX || idx.2 == usize::MAX {
        return Err("Cabeçalhos mínimos ausentes (código/descrição)".into());
    }

    let mut conn = open_db(&dbf).map_err(|e| e.to_string())?;
    super::core::migrate(&conn).map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let mut processed = 0usize;
    let mut upserted = 0usize;
    let mut linked = 0usize;
    // Limpa tabelas principais antes de reimportar (evita sobras como "GENERICO" se não existir mais na planilha)
    tx.execute("DELETE FROM product_vehicles", []).ok();
    tx.execute("DELETE FROM vehicle_makes", []).ok();
    tx.execute("DELETE FROM vehicles", []).ok();
    tx.execute("DELETE FROM makes", []).ok();
    tx.execute("DELETE FROM products", []).ok();
    tx.execute("DELETE FROM brand_groups", []).ok();
    tx.execute("DELETE FROM brands", []).ok();

    tx.execute("ALTER TABLE vehicles ADD COLUMN make TEXT", []).ok();
    tx.execute("ALTER TABLE vehicles ADD COLUMN make_id INTEGER", []).ok();
    tx.execute("CREATE TABLE IF NOT EXISTS makes (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)", []).ok();
    tx.execute("CREATE TABLE IF NOT EXISTS vehicle_makes (vehicle_id INTEGER NOT NULL, make_id INTEGER NOT NULL, PRIMARY KEY(vehicle_id, make_id))", []).ok();
    for row in rows {
        processed += 1;
        let cell = |i: usize| -> String {
            if i == usize::MAX {
                return String::new();
            }
            row.get(i)
                .map(|c| c.to_string())
                .unwrap_or_default()
                .trim()
                .to_string()
        };
        let brand_name = cell(idx.0);
        let code = cell(idx.1);
        if code.is_empty() {
            continue;
        }
        let description = cell(idx.2);
        let pgroup = cell(idx.3);
        let application = cell(idx.4);
        let make_val = if idx_make != usize::MAX { cell(idx_make) } else { String::new() };
        let details = if idx_details != usize::MAX { cell(idx_details) } else { String::new() };
        // veículos: se não existir coluna dedicada, derivamos da aplicação
        let vehicles_raw = if idx.5 != usize::MAX { cell(idx.5) } else { application.clone() };
        let oem = cell(idx.6);
        let similar = cell(idx.7);

        // brand
        let brand_id: i64 = if !brand_name.is_empty() {
            let found: Option<i64> = tx
                .query_row(
                    "SELECT id FROM brands WHERE UPPER(TRIM(name)) = UPPER(TRIM(?1))",
                    params![brand_name],
                    |r| r.get(0),
                )
                .optional()
                .unwrap_or(None);
            if let Some(id) = found {
                id
            } else {
                tx.execute("INSERT INTO brands(name) VALUES(TRIM(?1))", params![brand_name]).ok();
                tx.query_row(
                    "SELECT id FROM brands WHERE UPPER(TRIM(name)) = UPPER(TRIM(?1))",
                    params![brand_name],
                    |r| r.get(0),
                )
                .unwrap_or(1)
            }
        } else {
            1
        };

        tx.execute(
            "INSERT INTO products(brand_id, code, description, pgroup, application, oem, similar) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(code) DO UPDATE SET brand_id=excluded.brand_id, description=excluded.description, pgroup=excluded.pgroup, application=excluded.application, oem=excluded.oem, similar=excluded.similar",
            params![
                brand_id,
                code,
                description,
                if pgroup.is_empty() { None::<String> } else { Some(pgroup.clone()) },
                if application.is_empty() { None::<String> } else { Some(application.clone()) },
                if oem.is_empty() { None::<String> } else { Some(oem) },
                if similar.is_empty() { None::<String> } else { Some(similar) }
            ],
        )
        .map_err(|e| e.to_string())?;
        upserted += 1;
        let pid: i64 = tx
            .query_row("SELECT id FROM products WHERE code=?1", params![code], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if !details.is_empty() {
            tx.execute("UPDATE products SET details=?1 WHERE id=?2", params![details, pid]).ok();
        }

        if !vehicles_raw.is_empty() {
            tx.execute("DELETE FROM product_vehicles WHERE product_id=?1", params![pid]).ok();
            for v in vehicles_raw.split(|c| c == ';' || c == ',' || c == '|' || c == '\n' || c == '\r') {
                let v = v.trim();
                if v.is_empty() {
                    continue;
                }
                let make_tokens: Vec<String> = make_val
                    .split('/')
                    .map(|t| t.trim())
                    .filter(|t| !t.is_empty())
                    .map(|t| t.to_ascii_uppercase())
                    .collect();
                let mut make_ids: Vec<i64> = Vec::new();
                for mf in make_tokens.iter() {
                    tx.execute("INSERT OR IGNORE INTO makes(name) VALUES(?)", params![mf.clone()]).ok();
                    if let Some(mid) = tx
                        .query_row("SELECT id FROM makes WHERE name=?1", params![mf], |r| r.get(0))
                        .optional()
                        .unwrap_or(None)
                    {
                        make_ids.push(mid);
                    }
                }
                let primary_make = make_tokens.get(0).cloned().unwrap_or_default();
                let primary_make_id = make_ids.get(0).copied();
                tx.execute(
                    "INSERT INTO vehicles(name, make, make_id) VALUES(?, ?, ?) ON CONFLICT(name) DO UPDATE SET make=COALESCE(NULLIF(excluded.make,''), vehicles.make), make_id=COALESCE(excluded.make_id, vehicles.make_id)",
                    params![v, if primary_make.is_empty() { None::<String> } else { Some(primary_make.clone()) }, primary_make_id],
                )
                .ok();
                let vid: i64 = tx
                    .query_row("SELECT id FROM vehicles WHERE name=?1", params![v], |r| r.get(0))
                    .unwrap_or_else(|_| 0);
                if vid != 0 {
                    for mid in make_ids.iter() {
                        tx.execute(
                            "INSERT OR IGNORE INTO vehicle_makes(vehicle_id, make_id) VALUES(?1,?2)",
                            params![vid, mid],
                        )
                        .ok();
                    }
                    tx.execute(
                        "INSERT OR IGNORE INTO product_vehicles(product_id, vehicle_id) VALUES(?1,?2)",
                        params![pid, vid],
                    )
                    .ok();
                    linked += 1;
                }
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    super::core::seed_brand_groups(&conn).map_err(|e| e.to_string())?;
    let v = super::core::get_db_version(&conn).unwrap_or(0) + 1;
    super::core::set_db_version(&conn, v).ok();
    Ok(ImportResult {
        processed_rows: processed,
        upserted_products: upserted,
        linked_vehicles: linked,
        new_db_version: v,
    })
}
