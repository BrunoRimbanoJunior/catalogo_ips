use anyhow::Result;
use serde::{Deserialize, Serialize};
use tauri::Manager;

mod core {
    use super::*;
    use reqwest::Client;
    use rusqlite::{params, Connection, OptionalExtension};
    use walkdir::WalkDir;
    use calamine::{open_workbook_auto, Reader};
    use std::fs;
    use std::path::{Path, PathBuf};
    use tauri::AppHandle;
    use base64::Engine;

    pub const DB_FILE_NAME: &str = "catalog.db";
    pub const IMAGES_DIR_NAME: &str = "images";
    pub const META_DB_VERSION_KEY: &str = "db_version";

    #[derive(Debug, Serialize, Deserialize, Clone)]
    pub struct InitInfo {
        pub data_dir: String,
        pub images_dir: String,
        pub db_path: String,
        pub db_version: i64,
    }

    #[derive(Debug, Serialize, Deserialize, Clone)]
    pub struct Brand { pub id: i64, pub name: String }
    #[derive(Debug, Serialize, Deserialize, Clone)]
    pub struct Vehicle { pub id: i64, pub name: String }
    #[derive(Debug, Serialize, Deserialize, Clone)]
    pub struct ProductListItem { pub id: i64, pub code: String, pub description: String, pub brand: String, pub vehicles: Option<String> }
    #[derive(Debug, Serialize, Deserialize, Clone)]
    pub struct ProductDetails {
        pub id: i64,
        pub code: String,
        pub description: String,
        pub brand: String,
        pub application: Option<String>,
        pub details: Option<String>,
        pub similar: Option<String>,
        pub images: Vec<String>,
    }
    #[derive(Debug, Serialize, Deserialize, Clone)]
    pub struct SearchParams {
        pub brand_id: Option<i64>,
        pub group: Option<String>,
        pub vehicle_id: Option<i64>,
        pub code_query: Option<String>,
        pub limit: Option<i64>,
    }

    #[derive(Debug, Serialize, Deserialize)]
    pub struct ManifestDb { pub version: i64, pub url: String, pub sha256: Option<String> }
    #[derive(Debug, Serialize, Deserialize)]
    pub struct ManifestImageItem { pub file: String, pub sha256: Option<String> }
    #[derive(Debug, Serialize, Deserialize)]
    pub struct ManifestImages { pub base_url: String, pub files: Vec<ManifestImageItem> }
    #[derive(Debug, Serialize, Deserialize)]
    pub struct CatalogManifest { pub db: ManifestDb, pub images: Option<ManifestImages> }
    #[derive(Debug, Serialize, Deserialize)]
    pub struct SyncResult { pub updated_db: bool, pub downloaded_images: usize, pub db_version: i64 }

    #[derive(Debug, Serialize, Deserialize)]
    pub struct ImportResult { pub processed_rows: usize, pub upserted_products: usize, pub linked_vehicles: usize, pub new_db_version: i64 }
    #[derive(Debug, Serialize, Deserialize)]
    pub struct ImageIndexResult { pub scanned: usize, pub matched: usize, pub inserted: usize }
    #[derive(Debug, Serialize, Deserialize)]
    pub struct ExportResult { pub ok: bool, pub output: String }
    #[derive(Debug, Serialize, Deserialize)]
    pub struct BrandingResult { pub ok: bool, pub logo: Option<String>, pub background: Option<String> }

    #[derive(Debug, Serialize, Deserialize)]
    pub struct R2Creds {
        pub account_id: String,
        pub bucket: String,
        pub access_key_id: String,
        pub secret_access_key: String,
        pub endpoint: Option<String>,
        pub public_base_url: Option<String>,
    }

    fn app_data_dir(app: &AppHandle) -> Result<PathBuf> { Ok(app.path().app_local_data_dir()?) }
    fn db_path(app: &AppHandle) -> Result<PathBuf> { Ok(app_data_dir(app)?.join(DB_FILE_NAME)) }

    fn ensure_dirs(app: &AppHandle) -> Result<(PathBuf, PathBuf, PathBuf)> {
        let data = app_data_dir(app)?;
        if !data.exists() { fs::create_dir_all(&data)?; }
        let db = data.join(DB_FILE_NAME);
        let imgs = data.join(IMAGES_DIR_NAME);
        if !imgs.exists() { fs::create_dir_all(&imgs)?; }
        Ok((data, db, imgs))
    }
    fn open_db(path: &Path) -> Result<Connection> { Ok(Connection::open(path)?) }
    fn migrate(conn: &Connection) -> Result<()> {
        conn.execute_batch(r#"
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE IF NOT EXISTS brands (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
            CREATE TABLE IF NOT EXISTS vehicles (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
            CREATE TABLE IF NOT EXISTS products (
              id INTEGER PRIMARY KEY, brand_id INTEGER NOT NULL, code TEXT NOT NULL UNIQUE,
              description TEXT NOT NULL, application TEXT, details TEXT, oem TEXT, similar TEXT, pgroup TEXT,
              FOREIGN KEY(brand_id) REFERENCES brands(id)
            );
            CREATE TABLE IF NOT EXISTS product_vehicles (
              product_id INTEGER NOT NULL, vehicle_id INTEGER NOT NULL,
              PRIMARY KEY (product_id, vehicle_id)
            );
            CREATE TABLE IF NOT EXISTS images (
              id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL, filename TEXT NOT NULL,
              UNIQUE(product_id, filename)
            );
        "#)?;
        let current: Option<i64> = conn
            .query_row("SELECT CAST(value AS INTEGER) FROM meta WHERE key = ?1", params![META_DB_VERSION_KEY], |row| row.get(0))
            .optional()
            .unwrap_or(None);
        if current.is_none() {
            conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES(?1, ?2)", params![META_DB_VERSION_KEY, 0i64.to_string()])?;
        }
        // Caso a tabela products exista sem colunas novas, tenta adicionar
        let _ = conn.execute("ALTER TABLE products ADD COLUMN details TEXT", []);
        let _ = conn.execute("ALTER TABLE products ADD COLUMN oem TEXT", []);
        let _ = conn.execute("ALTER TABLE products ADD COLUMN similar TEXT", []);
        let _ = conn.execute("ALTER TABLE products ADD COLUMN pgroup TEXT", []);
        Ok(())
    }
    fn get_db_version(conn: &Connection) -> Result<i64> {
        Ok(conn.query_row("SELECT CAST(value AS INTEGER) FROM meta WHERE key = ?1", params![META_DB_VERSION_KEY], |row| row.get(0))?)
    }
    fn set_db_version(conn: &Connection, v: i64) -> Result<()> {
        conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES(?1, ?2)", params![META_DB_VERSION_KEY, v.to_string()])?; Ok(())
    }

    #[tauri::command]
    pub fn init_app(app: AppHandle) -> Result<InitInfo, String> {
        let (data_dir, db_file, imgs_dir) = ensure_dirs(&app).map_err(|e| e.to_string())?;
        let created = !db_file.exists();
        let conn = open_db(&db_file).map_err(|e| e.to_string())?;
        migrate(&conn).map_err(|e| e.to_string())?;
        if created { conn.execute("INSERT OR IGNORE INTO brands(id,name) VALUES(1,'GENÉRICO')", []).ok(); }
        let version = get_db_version(&conn).map_err(|e| e.to_string())?;
        Ok(InitInfo { data_dir: data_dir.to_string_lossy().into_owned(), images_dir: imgs_dir.to_string_lossy().into_owned(), db_path: db_file.to_string_lossy().into_owned(), db_version: version })
    }

    #[tauri::command]
    pub fn get_brands_cmd(app: AppHandle) -> Result<Vec<Brand>, String> {
        let conn = open_db(&db_path(&app).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("SELECT id, name FROM brands ORDER BY name").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| Ok(Brand { id: row.get(0)?, name: row.get(1)? })).map_err(|e| e.to_string())?;
        let mut out = Vec::new(); for r in rows { out.push(r.map_err(|e| e.to_string())?); } Ok(out)
    }

    // moved lower after search_products_cmd (avoid duplicate definitions)
    #[tauri::command]
    pub fn get_vehicles_cmd(app: AppHandle) -> Result<Vec<Vehicle>, String> {
        let conn = open_db(&db_path(&app).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("SELECT id, name FROM vehicles ORDER BY name").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| Ok(Vehicle { id: row.get(0)?, name: row.get(1)? })).map_err(|e| e.to_string())?;
        let mut out = Vec::new(); for r in rows { out.push(r.map_err(|e| e.to_string())?); } Ok(out)
    }

    #[tauri::command]
    pub fn get_makes_cmd(app: AppHandle) -> Result<Vec<String>, String> {
        let conn = open_db(&db_path(&app).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let sql = "SELECT DISTINCT UPPER(TRIM(CASE WHEN INSTR(name,' ')>0 THEN SUBSTR(name,1,INSTR(name,' ')-1) ELSE name END)) AS make FROM vehicles ORDER BY make";
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
        let mut out = Vec::new(); for r in rows { if let Ok(m) = r { let mm = m.trim().to_string(); if !mm.is_empty() { out.push(mm); } } }
        Ok(out)
    }

    #[tauri::command]
    pub fn get_vehicles_by_make_cmd(app: AppHandle, make: Option<String>) -> Result<Vec<Vehicle>, String> {
        let conn = open_db(&db_path(&app).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        if let Some(m) = make.and_then(|s| if s.trim().is_empty() { None } else { Some(s.to_ascii_uppercase()) }) {
            let sql = "SELECT id, name FROM vehicles WHERE UPPER(TRIM(CASE WHEN INSTR(name,' ')>0 THEN SUBSTR(name,1,INSTR(name,' ')-1) ELSE name END)) = ?1 ORDER BY name";
            let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
            let rows = stmt.query_map(params![m.clone()], |row| Ok(Vehicle { id: row.get(0)?, name: row.get(1)? })).map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            for r in rows { let v = r.map_err(|e| e.to_string())?; if v.name.to_ascii_uppercase().trim() != m { out.push(v); } }
            Ok(out)
        } else {
            let mut stmt = conn.prepare("SELECT id, name FROM vehicles ORDER BY name").map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |row| Ok(Vehicle { id: row.get(0)?, name: row.get(1)? })).map_err(|e| e.to_string())?;
            let mut out = Vec::new(); for r in rows { out.push(r.map_err(|e| e.to_string())?); } Ok(out)
        }
    }

    #[tauri::command]
    pub fn get_groups_cmd(app: AppHandle, brand_id: Option<i64>) -> Result<Vec<String>, String> {
        let conn = open_db(&db_path(&app).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let expr = group_expr_alias("g");
        let mut sql = format!("SELECT DISTINCT {} FROM products", expr);
        if brand_id.is_some() { sql.push_str(" WHERE brand_id = ?1"); }
        sql.push_str(" ORDER BY g");
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        if let Some(b) = brand_id {
            let rows = stmt.query_map(params![b], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
            for r in rows { if let Ok(g) = r { let gg = g.trim().to_string(); if !gg.is_empty() { out.push(gg); } } }
        } else {
            let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
            for r in rows { if let Ok(g) = r { let gg = g.trim().to_string(); if !gg.is_empty() { out.push(gg); } } }
        }
        Ok(out)
    }

    #[tauri::command]
    pub fn get_vehicles_filtered_cmd(app: AppHandle, brand_id: Option<i64>, group: Option<String>) -> Result<Vec<Vehicle>, String> {
        let conn = open_db(&db_path(&app).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let mut sql = String::from("SELECT DISTINCT v.id, v.name FROM vehicles v JOIN product_vehicles pv ON pv.vehicle_id = v.id JOIN products p ON p.id = pv.product_id");
        let mut wherec: Vec<String> = Vec::new();
        if brand_id.is_some() { wherec.push("p.brand_id = ?".into()); }
        if group.as_ref().map(|s| !s.trim().is_empty()).unwrap_or(false) {
            wherec.push("UPPER(TRIM(CASE WHEN TRIM(COALESCE(pgroup,''))<>'' THEN pgroup ELSE (CASE WHEN INSTR(description,' ')>0 THEN SUBSTR(description,1,INSTR(description,' ')-1) ELSE description END) END)) = ?".into());
        }
        if !wherec.is_empty() { sql.push_str(" WHERE "); sql.push_str(&wherec.join(" AND ")); }
        sql.push_str(" ORDER BY v.name");
        let mut params_vec: Vec<rusqlite::types::Value> = Vec::new();
        if let Some(b) = brand_id { params_vec.push(b.into()); }
        if let Some(g) = group.as_ref().filter(|s| !s.trim().is_empty()) { params_vec.push(g.to_ascii_uppercase().into()); }
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut rows = stmt.query(rusqlite::params_from_iter(params_vec)).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            out.push(Vehicle { id: row.get(0).map_err(|e| e.to_string())?, name: row.get(1).map_err(|e| e.to_string())? });
        }
        Ok(out)
    }

    #[derive(Debug, Serialize, Deserialize)]
    pub struct GroupsStats { pub products_with_group: i64, pub distinct_groups: i64 }

    #[tauri::command]
    pub fn get_groups_stats_cmd(app: AppHandle) -> Result<GroupsStats, String> {
        let conn = open_db(&db_path(&app).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let products_with_group: i64 = conn.query_row(
            "SELECT COUNT(1) FROM products WHERE TRIM(COALESCE(pgroup,'')) <> ''",
            [],
            |r| r.get(0),
        ).map_err(|e| e.to_string())?;
        let distinct_groups: i64 = conn.query_row(
            "SELECT COUNT(DISTINCT TRIM(COALESCE(pgroup,''))) FROM products WHERE TRIM(COALESCE(pgroup,'')) <> ''",
            [],
            |r| r.get(0),
        ).map_err(|e| e.to_string())?;
        Ok(GroupsStats { products_with_group, distinct_groups })
    }

    fn group_expr_alias(alias: &str) -> String {
        // Prefer pgroup; fallback to primeira palavra da descrição
        format!(
            "UPPER(TRIM(CASE WHEN TRIM(COALESCE(pgroup,''))<>'' THEN pgroup ELSE (CASE WHEN INSTR(description,' ')>0 THEN SUBSTR(description,1,INSTR(description,' ')-1) ELSE description END) END)) AS {}",
            alias
        )
    }
    #[tauri::command]
    pub fn get_types_cmd(app: AppHandle, brand_id: Option<i64>) -> Result<Vec<String>, String> {
        let conn = open_db(&db_path(&app).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let expr = "UPPER(TRIM(CASE WHEN INSTR(description,' ')>0 THEN SUBSTR(description,1,INSTR(description,' ')-1) ELSE description END))";
        let sql = if brand_id.is_some() {
            format!("SELECT DISTINCT {} AS t FROM products WHERE brand_id = ?1 ORDER BY t", expr)
        } else {
            format!("SELECT DISTINCT {} AS t FROM products ORDER BY t", expr)
        };
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        if let Some(bid) = brand_id {
            let rows = stmt.query_map(params![bid], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
            let mut out = Vec::new(); for r in rows { if let Ok(t) = r { if !t.trim().is_empty() { out.push(t); } } }
            Ok(out)
        } else {
            let rows = stmt.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
            let mut out = Vec::new(); for r in rows { if let Ok(t) = r { if !t.trim().is_empty() { out.push(t); } } }
            Ok(out)
        }
    }

    #[tauri::command]
    pub fn search_products_cmd(app: AppHandle, params: SearchParams) -> Result<Vec<ProductListItem>, String> {
        let conn = open_db(&db_path(&app).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        // Agrega veículos sem filtrar montadora para não bagunçar a ordem de parâmetros
        let mut sql = String::from("SELECT p.id, p.code, p.description, b.name, (SELECT group_concat(DISTINCT v2.name) FROM product_vehicles pv2 JOIN vehicles v2 ON v2.id=pv2.vehicle_id WHERE pv2.product_id=p.id) AS vehicles FROM products p JOIN brands b ON b.id=p.brand_id");

        let mut where_clauses: Vec<String> = Vec::new();
        if params.brand_id.is_some() { where_clauses.push("p.brand_id = ?".into()); }
        if params.group.as_ref().map(|s| !s.trim().is_empty()).unwrap_or(false) { where_clauses.push("UPPER(COALESCE(p.pgroup,'')) = ?".into()); }
        if params.vehicle_id.is_some() { where_clauses.push("EXISTS (SELECT 1 FROM product_vehicles pv WHERE pv.product_id=p.id AND pv.vehicle_id = ?)".into()); }
        if params.code_query.as_ref().map(|s| !s.trim().is_empty()).unwrap_or(false) {
            where_clauses.push(
                "(p.code LIKE ? OR COALESCE(p.oem,'') LIKE ? OR COALESCE(p.similar,'') LIKE ? OR EXISTS (SELECT 1 FROM product_vehicles pv3 JOIN vehicles v3 ON v3.id=pv3.vehicle_id WHERE pv3.product_id=p.id AND v3.name LIKE ?))"
                .into()
            );
        }
        if !where_clauses.is_empty() { sql.push_str(" WHERE "); sql.push_str(&where_clauses.join(" AND ")); }
        sql.push_str(" ORDER BY b.name, p.description"); if let Some(limit) = params.limit { sql.push_str(&format!(" LIMIT {}", limit)); }

        let mut values: Vec<rusqlite::types::Value> = Vec::new();
        if let Some(b) = params.brand_id { values.push(b.into()); }
        if let Some(g) = params.group.as_ref().filter(|s| !s.trim().is_empty()) { values.push(g.to_ascii_uppercase().into()); }
        if let Some(v) = params.vehicle_id { values.push(v.into()); }
        if let Some(q) = params.code_query.as_ref().filter(|s| !s.trim().is_empty()) {
            let like = format!("%{}%", q);
            values.push(like.clone().into()); // code
            values.push(like.clone().into()); // oem
            values.push(like.clone().into()); // similar
            values.push(like.into()); // vehicle name
        }

        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut rows = stmt.query(rusqlite::params_from_iter(values)).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            out.push(ProductListItem { id: row.get(0).map_err(|e| e.to_string())?, code: row.get(1).map_err(|e| e.to_string())?, description: row.get(2).map_err(|e| e.to_string())?, brand: row.get(3).map_err(|e| e.to_string())?, vehicles: row.get(4).ok() });
        }
        Ok(out)
    }

    #[tauri::command]
    pub fn get_product_details_cmd(app: AppHandle, product_id: i64) -> Result<ProductDetails, String> {
        let conn = open_db(&db_path(&app).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("SELECT p.id, p.code, p.description, p.application, p.details, p.similar, b.name FROM products p JOIN brands b ON b.id = p.brand_id WHERE p.id = ?1").map_err(|e| e.to_string())?;
        let (id, code, description, application, details, similar, brand): (i64, String, String, Option<String>, Option<String>, Option<String>, String) = stmt.query_row(params![product_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?))).map_err(|e| e.to_string())?;
        let mut img_stmt = conn.prepare("SELECT filename FROM images WHERE product_id = ?1 ORDER BY filename").map_err(|e| e.to_string())?;
        let images: Vec<String> = img_stmt.query_map(params![product_id], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
        Ok(ProductDetails { id, code, description, brand, application, details, similar, images })
    }

    async fn download_to_file(client: &Client, url: &str, dest: &Path) -> Result<()> {
        let resp = client.get(url).send().await?.error_for_status()?; let bytes = resp.bytes().await?; if let Some(parent) = dest.parent() { fs::create_dir_all(parent)?; } fs::write(dest, &bytes)?; Ok(())
    }

    fn index_from_file_list(conn: &mut Connection, files: &[String]) -> Result<ImageIndexResult> {
        let tx = conn.transaction()?;
        let mut scanned = 0usize; let mut matched = 0usize; let mut inserted = 0usize;
        for f in files {
            scanned += 1;
            // Usa apenas o último segmento como nome de arquivo lógico
            let rel = f.replace('\\', "/");
            let last = rel.rsplit('/').next().unwrap_or(&rel);
            let stem = last.split('.').next().unwrap_or(last);
            let candidates = candidate_codes(stem);
            let mut found: Option<i64> = None;
            for c in candidates {
                if let Ok(pid) = tx.query_row("SELECT id FROM products WHERE code=?1", params![c], |r| r.get(0)) { found = Some(pid); break; }
            }
            if let Some(pid) = found {
                matched += 1;
                if tx.execute("INSERT OR IGNORE INTO images(product_id, filename) VALUES(?1,?2)", params![pid, rel]).is_ok() { inserted += 1; }
            }
        }
        tx.commit()?;
        Ok(ImageIndexResult { scanned, matched, inserted })
    }

    #[tauri::command]
    pub fn set_branding_image(kind: String, source_path: String) -> Result<BrandingResult, String> {
        use std::io::Write;
        let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
        let out_dir = if cwd.ends_with("src-tauri") { cwd.parent().unwrap_or(&cwd).join("public").join("images") } else { cwd.join("public").join("images") };
        fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
        let ext = std::path::Path::new(&source_path).extension().and_then(|e| e.to_str()).unwrap_or("png");
        let fixed = if kind.to_lowercase().starts_with("logo") { format!("logo.{}", ext) } else { format!("bg.{}", ext) };
        let dest = out_dir.join(&fixed);
        fs::copy(&source_path, &dest).map_err(|e| e.to_string())?;
        let json_path = out_dir.join("branding.json");
        let mut logo: Option<String> = None;
        let mut background: Option<String> = None;
        if json_path.exists() {
            if let Ok(bytes) = fs::read(&json_path) { if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&bytes) { logo = val.get("logo").and_then(|v| v.as_str()).map(|s| s.to_string()); background = val.get("background").and_then(|v| v.as_str()).map(|s| s.to_string()); } }
        }
        if kind.to_lowercase().starts_with("logo") { logo = Some(fixed.clone()); } else { background = Some(fixed.clone()); }
        let obj = serde_json::json!({ "logo": logo, "background": background });
        let mut f = std::fs::File::create(&json_path).map_err(|e| e.to_string())?; f.write_all(serde_json::to_string_pretty(&obj).unwrap().as_bytes()).map_err(|e| e.to_string())?;
        Ok(BrandingResult { ok: true, logo, background })
    }

    #[tauri::command]
    pub async fn sync_from_manifest(app: AppHandle, manifest_url: String) -> Result<SyncResult, String> {
        let client = Client::new(); let (_, dbf, imgs_dir) = ensure_dirs(&app).map_err(|e| e.to_string())?;
        let manifest: CatalogManifest = client.get(&manifest_url).send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
        let mut updated_db = false; let local_version = { let conn = open_db(&dbf).map_err(|e| e.to_string())?; migrate(&conn).map_err(|e| e.to_string())?; get_db_version(&conn).unwrap_or(0) };
        if manifest.db.version > local_version { download_to_file(&client, &manifest.db.url, &dbf).await.map_err(|e| e.to_string())?; let conn = open_db(&dbf).map_err(|e| e.to_string())?; migrate(&conn).map_err(|e| e.to_string())?; if get_db_version(&conn).unwrap_or(0) < manifest.db.version { set_db_version(&conn, manifest.db.version).ok(); } updated_db = true; }
        let mut downloaded_images: usize = 0; if let Some(imgs) = manifest.images { for item in imgs.files { let local_path = imgs_dir.join(&item.file); if !local_path.exists() { let url = if item.file.starts_with("http://") || item.file.starts_with("https://") { item.file.clone() } else { format!("{}{}", imgs.base_url, item.file) }; if let Err(e) = download_to_file(&client, &url, &local_path).await { eprintln!("Falha ao baixar imagem {}: {}", item.file, e); } else { downloaded_images += 1; } } } }
        let conn = open_db(&dbf).map_err(|e| e.to_string())?; let final_version = get_db_version(&conn).unwrap_or(0);
        Ok(SyncResult { updated_db, downloaded_images, db_version: final_version })
    }

    #[tauri::command]
    pub async fn gen_manifest_r2(app: AppHandle, version: i64, db_url: String, out_path: String, r2: R2Creds) -> Result<String, String> {
        // Executa o script Node local para gerar o manifest a partir do R2
        use std::process::Command as PCommand;
        let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
        // Resolve caminho do script considerando dev (../scripts) ou raiz (scripts)
        let script_path = if cwd.ends_with("src-tauri") { cwd.parent().unwrap_or(&cwd).join("scripts").join("gen-manifest-r2.mjs") } else { cwd.join("scripts").join("gen-manifest-r2.mjs") };
        if !script_path.exists() {
            return Err(format!("Script não encontrado: {}", script_path.display()));
        }
        let mut cmd = PCommand::new("node");
        cmd.arg(script_path.as_os_str())
            .arg("--version").arg(version.to_string())
            .arg("--db-url").arg(&db_url)
            .arg("--out").arg(&out_path);
        // Env do R2
        cmd.env("R2_ACCOUNT_ID", &r2.account_id)
            .env("R2_BUCKET", &r2.bucket)
            .env("R2_ACCESS_KEY_ID", &r2.access_key_id)
            .env("R2_SECRET_ACCESS_KEY", &r2.secret_access_key);
        if let Some(ep) = r2.endpoint.as_ref() { cmd.env("R2_ENDPOINT", ep); }
        if let Some(pub_url) = r2.public_base_url.as_ref() { cmd.env("R2_PUBLIC_BASE_URL", pub_url); }
        let project_root: std::path::PathBuf = if cwd.ends_with("src-tauri") {
            cwd.parent().unwrap_or(&cwd).to_path_buf()
        } else {
            cwd.clone()
        };
        cmd.current_dir(&project_root);
        let output = cmd.output().map_err(|e| format!("Falha ao iniciar Node: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            return Err(format!("Manifest R2 falhou: {}\n{}", stderr, stdout));
        }
        Ok(out_path)
    }

    #[tauri::command]
    pub fn read_image_base64(app: AppHandle, path_or_rel: String) -> Result<String, String> {
        use std::fs;
        // monta caminho absoluto
        let (_, _dbf, imgs_dir) = ensure_dirs(&app).map_err(|e| e.to_string())?;
        let abs = {
            let p = std::path::PathBuf::from(&path_or_rel);
            if p.is_absolute() { p } else { imgs_dir.join(p) }
        };
        let bytes = fs::read(&abs).map_err(|e| format!("Falha ao ler imagem: {}", e))?;
        let ext = abs.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        let mime = match ext.as_str() { "jpg"|"jpeg" => "image/jpeg", "png" => "image/png", "webp" => "image/webp", "bmp" => "image/bmp", _ => "application/octet-stream" };
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        Ok(format!("data:{};base64,{}", mime, encoded))
    }

    #[tauri::command]
    pub async fn index_images_from_manifest(app: AppHandle, manifest_url: String) -> Result<ImageIndexResult, String> {
        let client = Client::new();
        let (_, dbf, _) = ensure_dirs(&app).map_err(|e| e.to_string())?;
        let manifest: CatalogManifest = client
            .get(&manifest_url)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        let files: Vec<String> = if let Some(imgs) = manifest.images {
            imgs.files.into_iter().map(|it| it.file).collect()
        } else { Vec::new() };
        let mut conn = open_db(&dbf).map_err(|e| e.to_string())?;
        migrate(&conn).map_err(|e| e.to_string())?;
        index_from_file_list(&mut conn, &files).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn export_db_to(app: AppHandle, dest_path: String) -> Result<ExportResult, String> {
        let (_, dbf, _) = ensure_dirs(&app).map_err(|e| e.to_string())?;
        let dest = std::path::PathBuf::from(&dest_path);
        if dest.exists() {
            std::fs::remove_file(&dest).map_err(|e| format!("Falha ao remover destino existente: {}", e))?;
        }
        let conn = open_db(&dbf).map_err(|e| e.to_string())?;
        let quoted = dest.to_string_lossy().replace('"', "\\\"");
        let sql = format!("VACUUM INTO \"{}\"", quoted);
        if let Err(e) = conn.execute(&sql, []) { return Err(format!("Falha no VACUUM INTO: {}", e)); }
        Ok(ExportResult { ok: true, output: dest_path })
    }
    fn norm(s: &str) -> String {
        let s = s.trim();
        let up = s.to_ascii_uppercase();
        up.chars()
            .map(|c| match c { 'Á'|'À'|'Ã'|'Â'|'Ä' => 'A', 'É'|'Ê'|'È'|'Ë' => 'E', 'Í'|'Ì'|'Î'|'Ï' => 'I', 'Ó'|'Ò'|'Õ'|'Ô'|'Ö' => 'O', 'Ú'|'Ù'|'Û'|'Ü' => 'U', 'Ç' => 'C', other => other })
            .collect()
    }

    fn header_key(s: &str) -> &'static str {
        let n = norm(s);
        if ["FABRICANTE","MARCA"].contains(&n.as_str()) { "brand" }
        else if ["CODIGO","CÓDIGO","COD","REFERENCIA","REF"].contains(&n.as_str()) { "code" }
        else if ["DESCRICAO","DESCRIÇÃO"].contains(&n.as_str()) { "description" }
        else if ["GRUPO","GRUPO DE PRODUTOS","CATEGORIA"].contains(&n.as_str()) { "group" }
        else if ["APLICACAO","APLICAÇÃO"].contains(&n.as_str()) { "application" }
        else if ["MONTADORA"].contains(&n.as_str()) { "ignore" }
        else if ["OEM"].contains(&n.as_str()) { "oem" }
        else if ["SIMILAR"].contains(&n.as_str()) { "similar" }
        else if ["ANO","LINK","FOTO","FOTOS"].contains(&n.as_str()) { "ignore" }
        else { "ignore" }
    }

    #[tauri::command]
    pub fn import_excel(app: AppHandle, path: String) -> Result<ImportResult, String> {
        let (_, dbf, _) = ensure_dirs(&app).map_err(|e| e.to_string())?;
        let mut wb = open_workbook_auto(&path).map_err(|e| format!("Falha abrindo XLSX: {e}"))?;
        let sheet_names = wb.sheet_names().to_vec();
        let sheet = sheet_names.get(0).ok_or_else(|| "Planilha vazia".to_string())?.to_string();
        let range = wb.worksheet_range(&sheet).map_err(|e| e.to_string())?;

        let mut rows = range.rows();
        let header = rows.next().ok_or("XLSX sem cabeçalho")?;
        let mut idx = (usize::MAX, usize::MAX, usize::MAX, usize::MAX, usize::MAX, usize::MAX, usize::MAX, usize::MAX);
        let mut idx_details: usize = usize::MAX;
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
                _ => {}
            }
            let t = cell.to_string().to_ascii_uppercase();
            if idx_details == usize::MAX && (t.contains("DETAL") || t.contains("OBSERV") || t == "OBS" || t.contains("NOTA")) {
                idx_details = i;
            }
        }
        if idx.1 == usize::MAX || idx.2 == usize::MAX { return Err("Cabeçalhos mínimos ausentes (código/descrição)".into()); }

        let mut conn = open_db(&dbf).map_err(|e| e.to_string())?;
        migrate(&conn).map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;

        let mut processed = 0usize; let mut upserted = 0usize; let mut linked = 0usize;
        for row in rows {
            processed += 1;
            let cell = |i: usize| -> String {
                if i == usize::MAX { return String::new(); }
                row.get(i).map(|c| c.to_string()).unwrap_or_default().trim().to_string()
            };
            let brand_name = cell(idx.0);
            let code = cell(idx.1);
            if code.is_empty() { continue; }
            let description = cell(idx.2);
            let pgroup = cell(idx.3);
            let application = cell(idx.4);
            let details = if idx_details != usize::MAX { cell(idx_details) } else { String::new() };
            // veículos: se não existir coluna dedicada, derivamos da aplicação
            let vehicles_raw = if idx.5 != usize::MAX { cell(idx.5) } else { application.clone() };
            let oem = cell(idx.6);
            let similar = cell(idx.7);

            // brand (normaliza para evitar duplicatas por caixa/espaço)
            let brand_id: i64 = if !brand_name.is_empty() {
                // tenta localizar por comparação case-insensitive e trim
                let found: Option<i64> = tx
                    .query_row(
                        "SELECT id FROM brands WHERE UPPER(TRIM(name)) = UPPER(TRIM(?1))",
                        params![brand_name],
                        |r| r.get(0),
                    )
                    .optional()
                    .unwrap_or(None);
                if let Some(id) = found { id } else {
                    tx.execute("INSERT INTO brands(name) VALUES(TRIM(?1))", params![brand_name]).ok();
                    tx.query_row(
                        "SELECT id FROM brands WHERE UPPER(TRIM(name)) = UPPER(TRIM(?1))",
                        params![brand_name],
                        |r| r.get(0),
                    )
                    .unwrap_or(1)
                }
            } else { 1 };

            // product upsert
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
            ).map_err(|e| e.to_string())?;
            upserted += 1;
            let pid: i64 = tx.query_row("SELECT id FROM products WHERE code=?1", params![code], |r| r.get(0)).map_err(|e| e.to_string())?;
            if !details.is_empty() { tx.execute("UPDATE products SET details=?1 WHERE id=?2", params![details, pid]).ok(); }

            // vehicles (split por ; , | e quebras de linha) — não usar '/'
            if !vehicles_raw.is_empty() {
                tx.execute("DELETE FROM product_vehicles WHERE product_id=?1", params![pid]).ok();
                for v in vehicles_raw.split(|c| c==';' || c==',' || c=='|' || c=='\n' || c=='\r') {
                    let v = v.trim(); if v.is_empty() { continue; }
                    tx.execute("INSERT OR IGNORE INTO vehicles(name) VALUES(?)", params![v]).ok();
                    let vid: i64 = tx.query_row("SELECT id FROM vehicles WHERE name=?1", params![v], |r| r.get(0)).unwrap_or_else(|_| 0);
                    if vid != 0 { tx.execute("INSERT OR IGNORE INTO product_vehicles(product_id, vehicle_id) VALUES(?1,?2)", params![pid, vid]).ok(); linked += 1; }
                }
            }
        }
        tx.commit().map_err(|e| e.to_string())?;

        // bump version
        let v = get_db_version(&conn).unwrap_or(0) + 1; set_db_version(&conn, v).ok();
        Ok(ImportResult { processed_rows: processed, upserted_products: upserted, linked_vehicles: linked, new_db_version: v })
    }

    fn candidate_codes(stem: &str) -> Vec<String> {
        let s = stem.trim();
        let up = s.to_ascii_uppercase();
        let mut cands = Vec::new();
        cands.push(up.clone());
        if let Some((first, _)) = up.split_once('_') { cands.push(first.to_string()); }
        if let Some((first, _)) = up.split_once('-') { cands.push(first.to_string()); }
        if let Some((first, _)) = up.split_once(' ') { cands.push(first.to_string()); }
        cands
    }

    #[tauri::command]
    pub fn index_images(app: AppHandle, root: String) -> Result<ImageIndexResult, String> {
        let (_, dbf, _imgs_dir) = ensure_dirs(&app).map_err(|e| e.to_string())?;
        let mut conn = open_db(&dbf).map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;

        let root_path = std::path::PathBuf::from(&root);
        let mut scanned=0usize; let mut matched=0usize; let mut inserted=0usize;
        for entry in WalkDir::new(&root_path).into_iter().filter_map(|e| e.ok()) {
            if !entry.file_type().is_file() { continue; }
            let p = entry.path();
            let ext = p.extension().and_then(|e| e.to_str()).map(|s| s.to_ascii_lowercase()).unwrap_or_default();
            if !["jpg","jpeg","png","webp","bmp"].contains(&ext.as_str()) { continue; }
            scanned += 1;
            let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let candidates = candidate_codes(stem);
            let mut found: Option<i64> = None;
            for c in candidates {
                let res: Result<i64, _> = tx.query_row("SELECT id FROM products WHERE code=?1", params![c], |r| r.get(0));
                if let Ok(pid) = res { found = Some(pid); break; }
            }
            if let Some(pid) = found {
                matched += 1;
                let rel = pathdiff::diff_paths(p, &root_path).unwrap_or_else(|| p.to_path_buf());
                let rel_str = rel.to_string_lossy().replace('\\', "/");
                if tx.execute("INSERT OR IGNORE INTO images(product_id, filename) VALUES(?1,?2)", params![pid, rel_str]).is_ok() { inserted += 1; }
            }
        }
        tx.commit().ok();
        Ok(ImageIndexResult { scanned, matched, inserted })
    }
}

// Re-export types for the frontend typings (via invoke JSON)
pub use core::{CatalogManifest, InitInfo, SyncResult};

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String { format!("Hello, {}! You've been greeted from Rust!", name) }

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            core::init_app,
            core::get_brands_cmd,
            core::get_vehicles_cmd,
            core::get_makes_cmd,
            core::get_vehicles_by_make_cmd,
            core::get_groups_cmd,
            core::get_vehicles_filtered_cmd,
            core::get_types_cmd,
            core::get_groups_stats_cmd,
            core::search_products_cmd,
            core::get_product_details_cmd,
            core::sync_from_manifest,
            core::index_images_from_manifest,
            core::import_excel,
            core::index_images,
            core::export_db_to,
            core::set_branding_image,
            core::gen_manifest_r2,
            core::read_image_base64
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
