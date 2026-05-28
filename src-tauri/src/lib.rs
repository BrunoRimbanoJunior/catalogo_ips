use anyhow::Result;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

mod call_img;
mod db;
mod desc;
mod importer;

mod core {
    use super::*;
    use crate::call_img::load_env_key;
    use crate::db::{db_path, ensure_dirs, open_db, META_DB_VERSION_KEY, META_MANIFEST_HASH_KEY};
    use reqwest::{
        header::{ACCEPT_ENCODING, CONTENT_ENCODING},
        Client,
    };
    use rusqlite::{params, Connection, OptionalExtension};
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use std::collections::{HashMap, HashSet};
    use std::fs;
    use std::path::{Component, Path, PathBuf};
    use std::process::{Command as PCommand, Stdio};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tauri::AppHandle;
    use tokio::sync::Semaphore;
    use tokio::task::JoinSet;
    use walkdir::WalkDir;

    const GROUP_EXPR_SQL: &str = "UPPER(TRIM(COALESCE(pgroup,'')))";
    const LAUNCH_CANON: &str = "lancamentos";
    const DEFAULT_IMG_CONCURRENCY: usize = 16;

    fn normalize_launch_token(s: &str) -> String {
        s.to_lowercase()
            .replace("Ã§", "c")
            .replace("Ã£", "a")
            .replace('ã', "a")
            .replace('á', "a")
            .replace('â', "a")
            .replace('à', "a")
            .replace('ä', "a")
            .replace('ç', "c")
    }

    fn is_launch_component(name: &str) -> bool {
        normalize_launch_token(name) == LAUNCH_CANON
    }

    fn is_launch_path(path: &str) -> bool {
        path.replace('\\', "/").split('/').any(is_launch_component)
    }

    fn normalize_rel_path(path: &str) -> String {
        let mut cleaned = path.replace('\\', "/");
        while cleaned.starts_with("./") {
            cleaned = cleaned.trim_start_matches("./").to_string();
        }
        while cleaned.starts_with('/') {
            cleaned = cleaned.trim_start_matches('/').to_string();
        }
        cleaned.to_ascii_lowercase()
    }

    #[derive(Debug, Serialize, Deserialize, Clone)]
    pub struct InitInfo {
        pub data_dir: String,
        pub images_dir: String,
        pub db_path: String,
        pub db_version: i64,
    }

    #[derive(Debug, Serialize, Deserialize, Clone)]
    pub struct Brand {
        pub id: i64,
        pub name: String,
    }
    #[derive(Debug, Serialize, Deserialize, Clone)]
    pub struct Vehicle {
        pub id: i64,
        pub name: String,
        pub category: Option<String>,
    }
    #[derive(Debug, Serialize, Deserialize, Clone)]
    pub struct ProductListItem {
        pub id: i64,
        pub code: String,
        pub description: String,
        pub brand: String,
        pub vehicles: Option<String>,
    }
    #[derive(Debug, Serialize, Deserialize, Clone)]
    pub struct ProductDetails {
        pub id: i64,
        pub code: String,
        pub description: String,
        pub brand: String,
        pub application: Option<String>,
        pub details: Option<String>,
        pub ean_gtin: Option<String>,
        pub altura: Option<String>,
        pub largura: Option<String>,
        pub comprimento: Option<String>,
        pub similar: Option<String>,
        pub images: Vec<String>,
    }
    #[derive(Debug, Serialize, Deserialize, Clone)]
    pub struct SearchParams {
        pub brand_id: Option<i64>,
        pub group: Option<String>,
        pub make: Option<String>,
        pub vehicle_id: Option<i64>,
        pub code_query: Option<String>,
        pub limit: Option<i64>,
    }
    #[derive(Debug, Serialize, Deserialize, Clone)]
    pub struct PrintCatalogParams {
        pub lines: Option<Vec<String>>,
        pub groups: Option<Vec<String>>,
        pub makes: Option<Vec<String>>,
        pub vehicles: Option<Vec<String>>,
        #[serde(default, alias = "launchOnly")]
        pub launch_only: bool,
        #[serde(default, alias = "favoritesOnly")]
        pub favorites_only: bool,
        pub limit: Option<i64>,
    }
    #[derive(Debug, Serialize, Deserialize, Clone)]
    pub struct PrintCatalogItem {
        pub product_id: i64,
        pub code: String,
        pub description: String,
        pub brand: String,
        pub group: Option<String>,
        pub line: Option<String>,
        pub make: Option<String>,
        pub vehicle: String,
        pub similar: Option<String>,
        pub image: Option<String>,
    }
    #[derive(Debug, Serialize, Deserialize, Clone)]
    pub struct ExcelExportResult {
        pub rows: usize,
        pub output: String,
    }

    #[derive(Debug, Serialize, Deserialize)]
    pub struct ManifestDb {
        pub version: i64,
        pub url: String,
        pub sha256: Option<String>,
    }
    #[derive(Debug, Serialize, Deserialize, Clone)]
    pub struct ManifestImageItem {
        pub file: String,
        pub sha256: Option<String>,
    }
    #[derive(Debug, Serialize, Deserialize, Clone)]
    pub struct ManifestImages {
        pub base_url: String,
        pub files: Vec<ManifestImageItem>,
    }

    #[derive(Debug, Serialize, Deserialize, Clone)]
    pub struct RcloneSyncResult {
        pub ok: bool,
        pub exit_code: Option<i32>,
        pub command_file: String,
    }
    #[derive(Debug, Serialize, Deserialize, Clone)]
    pub struct AppVersionInfo {
        pub resolved_version: String,
        pub consistent: bool,
        pub package_json_version: String,
        pub cargo_toml_version: String,
        pub tauri_conf_version: String,
        pub cargo_lock_version: Option<String>,
        pub app_root: String,
    }
    #[derive(Debug, Serialize, Deserialize)]
    pub struct CatalogManifest {
        pub db: ManifestDb,
        pub images: Option<ManifestImages>,
    }
    #[derive(Debug, Serialize, Deserialize)]
    pub struct SyncResult {
        pub updated_db: bool,
        pub downloaded_images: usize,
        pub db_version: i64,
    }
    #[derive(Debug, Serialize, Deserialize)]
    pub struct CleanupResult {
        pub removed_files: usize,
        pub kept_files: usize,
        pub total_scanned: usize,
        pub manifest_files: usize,
    }

    #[derive(Debug, Serialize, Deserialize)]
    pub struct ImageIndexResult {
        pub scanned: usize,
        pub matched: usize,
        pub inserted: usize,
    }
    #[derive(Debug, Serialize, Deserialize)]
    pub struct ExportResult {
        pub ok: bool,
        pub output: String,
    }
    #[derive(Debug, Serialize, Deserialize)]
    pub struct BrandingResult {
        pub ok: bool,
        pub logo: Option<String>,
        pub background: Option<String>,
        pub header_logos: Option<Vec<String>>,
    }

    #[derive(Debug, Serialize, Deserialize)]
    pub struct R2Creds {
        pub account_id: String,
        pub bucket: String,
        pub access_key_id: String,
        pub secret_access_key: String,
        pub endpoint: Option<String>,
        pub public_base_url: Option<String>,
    }

    pub(crate) fn migrate(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            r#"
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE IF NOT EXISTS brands (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
            CREATE TABLE IF NOT EXISTS makes (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
            CREATE TABLE IF NOT EXISTS vehicles (
              id INTEGER PRIMARY KEY,
              name TEXT NOT NULL UNIQUE,
              make TEXT,
              make_id INTEGER,
              category TEXT,
              FOREIGN KEY(make_id) REFERENCES makes(id)
            );
            CREATE TABLE IF NOT EXISTS products (
              id INTEGER PRIMARY KEY, brand_id INTEGER NOT NULL, code TEXT NOT NULL UNIQUE,
              description TEXT NOT NULL, application TEXT, details TEXT, oem TEXT, similar TEXT, pgroup TEXT,
              ean_gtin TEXT, altura TEXT, largura TEXT, comprimento TEXT,
              FOREIGN KEY(brand_id) REFERENCES brands(id)
            );
            CREATE TABLE IF NOT EXISTS vehicle_makes (
              vehicle_id INTEGER NOT NULL,
              make_id INTEGER NOT NULL,
              PRIMARY KEY (vehicle_id, make_id),
              FOREIGN KEY(vehicle_id) REFERENCES vehicles(id),
              FOREIGN KEY(make_id) REFERENCES makes(id)
            );
            CREATE TABLE IF NOT EXISTS product_vehicles (
              product_id INTEGER NOT NULL, vehicle_id INTEGER NOT NULL,
              PRIMARY KEY (product_id, vehicle_id)
            );
            CREATE TABLE IF NOT EXISTS images (
              id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL, filename TEXT NOT NULL,
              UNIQUE(product_id, filename)
            );
            CREATE TABLE IF NOT EXISTS images_cache (
              filename TEXT PRIMARY KEY,
              sha256 TEXT
            );
            CREATE TABLE IF NOT EXISTS brand_groups (
              brand_id INTEGER NOT NULL,
              name TEXT NOT NULL,
              PRIMARY KEY (brand_id, name),
              FOREIGN KEY(brand_id) REFERENCES brands(id)
            );
        "#,
        )?;
        let current: Option<i64> = conn
            .query_row(
                "SELECT CAST(value AS INTEGER) FROM meta WHERE key = ?1",
                params![META_DB_VERSION_KEY],
                |row| row.get(0),
            )
            .optional()
            .unwrap_or(None);
        if current.is_none() {
            conn.execute(
                "INSERT OR REPLACE INTO meta(key,value) VALUES(?1, ?2)",
                params![META_DB_VERSION_KEY, 0i64.to_string()],
            )?;
        }
        // Caso tabelas existam sem colunas novas, tenta adicionar
        let _ = conn.execute("ALTER TABLE products ADD COLUMN details TEXT", []);
        let _ = conn.execute("ALTER TABLE products ADD COLUMN oem TEXT", []);
        let _ = conn.execute("ALTER TABLE products ADD COLUMN similar TEXT", []);
        let _ = conn.execute("ALTER TABLE products ADD COLUMN pgroup TEXT", []);
        let _ = conn.execute("ALTER TABLE products ADD COLUMN ean_gtin TEXT", []);
        let _ = conn.execute("ALTER TABLE products ADD COLUMN altura TEXT", []);
        let _ = conn.execute("ALTER TABLE products ADD COLUMN largura TEXT", []);
        let _ = conn.execute("ALTER TABLE products ADD COLUMN comprimento TEXT", []);
        let _ = conn.execute("ALTER TABLE vehicles ADD COLUMN make TEXT", []);
        let _ = conn.execute("ALTER TABLE vehicles ADD COLUMN make_id INTEGER", []);
        let _ = conn.execute("ALTER TABLE vehicles ADD COLUMN category TEXT", []);
        let _ = conn.execute(
            "CREATE TABLE IF NOT EXISTS vehicle_makes (vehicle_id INTEGER NOT NULL, make_id INTEGER NOT NULL, PRIMARY KEY(vehicle_id, make_id))",
            [],
        );
        let _ = conn.execute(
            "CREATE TABLE IF NOT EXISTS makes (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)",
            [],
        );
        let _ = conn.execute(
            "UPDATE vehicles SET make = UPPER(TRIM(CASE WHEN INSTR(name,' ')>0 THEN SUBSTR(name,1,INSTR(name,' ')-1) ELSE name END)) WHERE make IS NULL OR TRIM(COALESCE(make,''))=''",
            [],
        );
        let _ = conn.execute(
            "INSERT OR IGNORE INTO makes(name) SELECT DISTINCT UPPER(TRIM(COALESCE(make,''))) FROM vehicles WHERE TRIM(COALESCE(make,'')) <> ''",
            [],
        );
        let _ = conn.execute(
            "UPDATE vehicles SET make_id = (SELECT id FROM makes m WHERE UPPER(TRIM(m.name)) = UPPER(TRIM(COALESCE(vehicles.make,'')))) WHERE make_id IS NULL AND TRIM(COALESCE(make,'')) <> ''",
            [],
        );
        let _ = conn.execute(
            "INSERT OR IGNORE INTO vehicle_makes(vehicle_id, make_id) SELECT v.id, m.id FROM vehicles v JOIN makes m ON UPPER(TRIM(m.name)) = UPPER(TRIM(COALESCE(v.make,''))) WHERE TRIM(COALESCE(v.make,'')) <> ''",
            [],
        );
        let _ = seed_brand_groups(conn);
        Ok(())
    }
    pub(crate) fn get_db_version(conn: &Connection) -> Result<i64> {
        Ok(conn.query_row(
            "SELECT CAST(value AS INTEGER) FROM meta WHERE key = ?1",
            params![META_DB_VERSION_KEY],
            |row| row.get(0),
        )?)
    }
    pub(crate) fn set_db_version(conn: &Connection, v: i64) -> Result<()> {
        conn.execute(
            "INSERT OR REPLACE INTO meta(key,value) VALUES(?1, ?2)",
            params![META_DB_VERSION_KEY, v.to_string()],
        )?;
        Ok(())
    }
    fn get_manifest_hash(conn: &Connection) -> Result<Option<String>> {
        Ok(conn
            .query_row(
                "SELECT value FROM meta WHERE key = ?1",
                params![META_MANIFEST_HASH_KEY],
                |row| row.get(0),
            )
            .optional()?)
    }
    fn set_manifest_hash(conn: &Connection, v: &str) -> Result<()> {
        conn.execute(
            "INSERT OR REPLACE INTO meta(key,value) VALUES(?1, ?2)",
            params![META_MANIFEST_HASH_KEY, v],
        )?;
        Ok(())
    }

    #[tauri::command]
    pub fn init_app(app: AppHandle) -> Result<InitInfo, String> {
        let (data_dir, db_file, imgs_dir) = ensure_dirs(&app).map_err(|e| e.to_string())?;
        // se a chave vier empacotada, persiste em descrypt.key para facilitar em runtime
        if let Some(k) = load_env_key(app.path().resource_dir().ok().as_deref(), Some(&data_dir)) {
            let key_file = data_dir.join("descrypt.key");
            if !key_file.exists() {
                let _ = std::fs::write(&key_file, k.as_bytes());
            }
        }
        let created = !db_file.exists();
        if created {
            if let Ok(res_dir) = app.path().resource_dir() {
                // Tente multiplos caminhos possiveis dentro de resources
                let candidates = [
                    res_dir.join("catalog.db"),
                    res_dir.join("data").join("catalog.db"),
                ];
                for seed in candidates.iter() {
                    if seed.exists() {
                        let _ = std::fs::copy(seed, &db_file);
                        break;
                    }
                }
            }
            if !db_file.exists() {
                if let Ok(cwd) = std::env::current_dir() {
                    let maybe = if cwd.ends_with("src-tauri") {
                        cwd.parent().unwrap_or(&cwd).join("data").join("catalog.db")
                    } else {
                        cwd.join("data").join("catalog.db")
                    };
                    if maybe.exists() {
                        let _ = std::fs::copy(&maybe, &db_file);
                    }
                }
            }
        }
        let conn = open_db(&db_file).map_err(|e| e.to_string())?;
        migrate(&conn).map_err(|e| e.to_string())?;

        // Normaliza montadoras e coluna make em vehicles
        let _ = conn.execute("ALTER TABLE vehicles ADD COLUMN make TEXT", []);
        let _ = conn.execute("ALTER TABLE vehicles ADD COLUMN make_id INTEGER", []);
        let _ = conn.execute("ALTER TABLE vehicles ADD COLUMN category TEXT", []);
        let _ = conn.execute(
            "CREATE TABLE IF NOT EXISTS makes (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)",
            [],
        );
        let _ = conn.execute(
            "UPDATE vehicles SET make = UPPER(TRIM(CASE WHEN INSTR(name,' ')>0 THEN SUBSTR(name,1,INSTR(name,' ')-1) ELSE name END)) WHERE make IS NULL OR TRIM(COALESCE(make,''))=''",
            [],
        );
        let _ = conn.execute(
            "INSERT OR IGNORE INTO makes(name) SELECT DISTINCT UPPER(TRIM(COALESCE(make,''))) FROM vehicles WHERE TRIM(COALESCE(make,'')) <> ''",
            [],
        );
        let _ = conn.execute(
            "UPDATE vehicles SET make_id = (SELECT id FROM makes m WHERE UPPER(TRIM(m.name)) = UPPER(TRIM(COALESCE(vehicles.make,'')))) WHERE make_id IS NULL AND TRIM(COALESCE(make,'')) <> ''",
            [],
        );

        let version = get_db_version(&conn).map_err(|e| e.to_string())?;
        Ok(InitInfo {
            data_dir: data_dir.to_string_lossy().into_owned(),
            images_dir: imgs_dir.to_string_lossy().into_owned(),
            db_path: db_file.to_string_lossy().into_owned(),
            db_version: version,
        })
    }

    #[tauri::command]
    pub fn get_brands_cmd(app: AppHandle) -> Result<Vec<Brand>, String> {
        let conn =
            open_db(&db_path(&app).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, name FROM brands ORDER BY name")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(Brand {
                    id: row.get(0)?,
                    name: row.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    // moved lower after search_products_cmd (avoid duplicate definitions)
    #[tauri::command]
    pub fn get_vehicles_cmd(app: AppHandle) -> Result<Vec<Vehicle>, String> {
        let conn =
            open_db(&db_path(&app).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, name, category FROM vehicles ORDER BY name")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(Vehicle {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    category: row.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    #[tauri::command]
    pub fn get_makes_cmd(app: AppHandle) -> Result<Vec<String>, String> {
        let conn =
            open_db(&db_path(&app).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let sql = "SELECT name FROM makes ORDER BY name";
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            if let Ok(m) = r {
                let mm = m.trim().to_string();
                if !mm.is_empty() {
                    out.push(mm);
                }
            }
        }
        Ok(out)
    }

    #[tauri::command]
    pub fn get_vehicles_by_make_cmd(
        app: AppHandle,
        make: Option<String>,
    ) -> Result<Vec<Vehicle>, String> {
        let conn =
            open_db(&db_path(&app).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let mut sql = String::from("SELECT id, name, category FROM vehicles");
        let mut params_vec: Vec<rusqlite::types::Value> = Vec::new();
        if let Some(m) = make
            .as_ref()
            .map(|s| s.trim().to_ascii_uppercase())
            .filter(|s| !s.is_empty())
        {
            sql.push_str(" WHERE UPPER(TRIM(COALESCE(make,''))) = ?");
            params_vec.push(m.into());
        }
        sql.push_str(" ORDER BY name");
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(params_vec), |row| {
                Ok(Vehicle {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    category: row.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    #[tauri::command]
    pub fn get_groups_cmd(
        app: AppHandle,
        brand_id: Option<i64>,
        brand_name: Option<String>,
        brand_id_camel: Option<i64>,
        brand_name_camel: Option<String>,
    ) -> Result<Vec<String>, String> {
        let incoming_id = brand_id.or(brand_id_camel);
        let incoming_name = brand_name.clone().or(brand_name_camel.clone());
        let conn =
            open_db(&db_path(&app).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        seed_brand_groups(&conn).ok();
        if let Some(bid) = incoming_id {
            let mut out = fetch_brand_groups(&conn, Some(bid)).map_err(|e| e.to_string())?;
            if out.is_empty() {
                out = fetch_groups_from_products(&conn, Some(bid)).map_err(|e| e.to_string())?;
            }
            return Ok(out);
        }
        let resolved = resolve_brand_id(&conn, incoming_id, incoming_name.clone())
            .map_err(|e| e.to_string())?;
        let mut out = fetch_brand_groups(&conn, resolved).map_err(|e| e.to_string())?;
        if out.is_empty() {
            out = fetch_groups_from_products(&conn, resolved).map_err(|e| e.to_string())?;
        }
        Ok(out)
    }

    #[tauri::command]
    pub fn get_vehicles_filtered_cmd(
        app: AppHandle,
        brand_id: Option<i64>,
        group: Option<String>,
        make: Option<String>,
    ) -> Result<Vec<Vehicle>, String> {
        let conn =
            open_db(&db_path(&app).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let mut sql = String::from(
            "SELECT DISTINCT v.id, v.name, v.category FROM vehicles v JOIN product_vehicles pv ON pv.vehicle_id = v.id JOIN products p ON p.id = pv.product_id",
        );
        let mut wherec: Vec<String> = Vec::new();
        if brand_id.is_some() {
            wherec.push("p.brand_id = ?".into());
        }
        if group
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
        {
            wherec.push("UPPER(TRIM(COALESCE(pgroup,''))) = ?".into());
        }
        if make.as_ref().map(|s| !s.trim().is_empty()).unwrap_or(false) {
            wherec.push("UPPER(TRIM(COALESCE(v.make,''))) = ?".into());
        }
        if !wherec.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&wherec.join(" AND "));
        }
        sql.push_str(" ORDER BY v.name");
        let mut params_vec: Vec<rusqlite::types::Value> = Vec::new();
        if let Some(b) = brand_id {
            params_vec.push(b.into());
        }
        if let Some(g) = group.as_ref().filter(|s| !s.trim().is_empty()) {
            params_vec.push(g.to_ascii_uppercase().into());
        }
        if let Some(m) = make.as_ref().filter(|s| !s.trim().is_empty()) {
            params_vec.push(m.to_ascii_uppercase().into());
        }
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query(rusqlite::params_from_iter(params_vec))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            out.push(Vehicle {
                id: row.get(0).map_err(|e| e.to_string())?,
                name: row.get(1).map_err(|e| e.to_string())?,
                category: row.get(2).map_err(|e| e.to_string())?,
            });
        }
        Ok(out)
    }

    #[derive(Debug, Serialize, Deserialize)]
    pub struct GroupsStats {
        pub products_with_group: i64,
        pub distinct_groups: i64,
    }

    #[tauri::command]
    pub fn get_groups_stats_cmd(app: AppHandle) -> Result<GroupsStats, String> {
        let conn =
            open_db(&db_path(&app).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let products_with_group: i64 = conn
            .query_row(
                "SELECT COUNT(1) FROM products WHERE TRIM(COALESCE(pgroup,'')) <> ''",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let distinct_groups: i64 = conn.query_row(
            "SELECT COUNT(DISTINCT TRIM(COALESCE(pgroup,''))) FROM products WHERE TRIM(COALESCE(pgroup,'')) <> ''",
            [],
            |r| r.get(0),
        ).map_err(|e| e.to_string())?;
        Ok(GroupsStats {
            products_with_group,
            distinct_groups,
        })
    }

    fn group_expr_alias(alias: &str) -> String {
        format!("{} AS {}", GROUP_EXPR_SQL, alias)
    }

    pub(crate) fn seed_brand_groups(conn: &Connection) -> Result<()> {
        conn.execute("DELETE FROM brand_groups", [])?;
        let sql = format!(
            "INSERT INTO brand_groups(brand_id, name)
             SELECT DISTINCT brand_id, {expr}
             FROM products
             WHERE TRIM({expr}) <> ''",
            expr = GROUP_EXPR_SQL
        );
        conn.execute(&sql, [])?;
        Ok(())
    }

    fn fetch_brand_groups(conn: &Connection, brand_id: Option<i64>) -> Result<Vec<String>> {
        let mut out = Vec::new();
        if let Some(b) = brand_id {
            let mut stmt =
                conn.prepare("SELECT name FROM brand_groups WHERE brand_id=?1 ORDER BY name")?;
            let rows = stmt.query_map(params![b], |row| row.get::<_, String>(0))?;
            for r in rows {
                if let Ok(name) = r {
                    let trimmed = name.trim().to_string();
                    if !trimmed.is_empty() {
                        out.push(trimmed);
                    }
                }
            }
        } else {
            let mut stmt = conn.prepare("SELECT DISTINCT name FROM brand_groups ORDER BY name")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            for r in rows {
                if let Ok(name) = r {
                    let trimmed = name.trim().to_string();
                    if !trimmed.is_empty() {
                        out.push(trimmed);
                    }
                }
            }
        }
        Ok(out)
    }

    fn fetch_groups_from_products(conn: &Connection, brand_id: Option<i64>) -> Result<Vec<String>> {
        let expr = group_expr_alias("g");
        let mut sql = format!("SELECT DISTINCT {} FROM products", expr);
        if brand_id.is_some() {
            sql.push_str(" WHERE brand_id = ?1");
        }
        sql.push_str(" ORDER BY g");
        let mut stmt = conn.prepare(&sql)?;
        let mut out = Vec::new();
        if let Some(b) = brand_id {
            let rows = stmt.query_map(params![b], |r| r.get::<_, String>(0))?;
            for r in rows {
                if let Ok(g) = r {
                    let gg = g.trim().to_string();
                    if !gg.is_empty() {
                        out.push(gg);
                    }
                }
            }
        } else {
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            for r in rows {
                if let Ok(g) = r {
                    let gg = g.trim().to_string();
                    if !gg.is_empty() {
                        out.push(gg);
                    }
                }
            }
        }
        Ok(out)
    }

    fn resolve_brand_id(
        conn: &Connection,
        brand_id: Option<i64>,
        brand_name: Option<String>,
    ) -> Result<Option<i64>> {
        if brand_id.is_some() {
            return Ok(brand_id);
        }
        if let Some(name) = brand_name {
            let trimmed = name.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }
            let found: Option<i64> = conn
                .query_row(
                    "SELECT id FROM brands WHERE UPPER(TRIM(name)) = UPPER(TRIM(?1))",
                    params![trimmed],
                    |r| r.get(0),
                )
                .optional()?;
            return Ok(found);
        }
        Ok(None)
    }
    #[tauri::command]
    pub fn get_types_cmd(app: AppHandle, brand_id: Option<i64>) -> Result<Vec<String>, String> {
        let conn =
            open_db(&db_path(&app).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let expr = "UPPER(TRIM(CASE WHEN INSTR(description,' ')>0 THEN SUBSTR(description,1,INSTR(description,' ')-1) ELSE description END))";
        let sql = if brand_id.is_some() {
            format!(
                "SELECT DISTINCT {} AS t FROM products WHERE brand_id = ?1 ORDER BY t",
                expr
            )
        } else {
            format!("SELECT DISTINCT {} AS t FROM products ORDER BY t", expr)
        };
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        if let Some(bid) = brand_id {
            let rows = stmt
                .query_map(params![bid], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            for r in rows {
                if let Ok(t) = r {
                    if !t.trim().is_empty() {
                        out.push(t);
                    }
                }
            }
            Ok(out)
        } else {
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            for r in rows {
                if let Ok(t) = r {
                    if !t.trim().is_empty() {
                        out.push(t);
                    }
                }
            }
            Ok(out)
        }
    }

    #[tauri::command]
    pub fn search_products_cmd(
        app: AppHandle,
        params: SearchParams,
    ) -> Result<Vec<ProductListItem>, String> {
        let conn =
            open_db(&db_path(&app).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        // Agrega veiculos sem filtrar montadora para nao baguncar a ordem de parametros
        let mut sql = String::from("SELECT p.id, p.code, p.description, b.name, (SELECT group_concat(DISTINCT v2.name) FROM product_vehicles pv2 JOIN vehicles v2 ON v2.id=pv2.vehicle_id WHERE pv2.product_id=p.id) AS vehicles FROM products p JOIN brands b ON b.id=p.brand_id");
        // Quando filtra por veículo, precisamos do nome para permitir match parcial no texto.
        let vehicle_name: Option<String> = if let Some(vid) = params.vehicle_id {
            conn.query_row(
                "SELECT name FROM vehicles WHERE id = ?1",
                params![vid],
                |row| row.get(0),
            )
            .optional()
            .unwrap_or(None)
        } else {
            None
        };
        let mut vehicle_token: Option<String> = None;
        if let Some(ref name) = vehicle_name {
            vehicle_token = name
                .split(|c: char| c.is_whitespace() || c == '/' || c == '\\' || c == '-')
                .map(|s| s.trim())
                .find(|s| !s.is_empty())
                .map(|s| s.to_ascii_uppercase());
        }

        let mut where_clauses: Vec<String> = Vec::new();
        if params.brand_id.is_some() {
            where_clauses.push("p.brand_id = ?".into());
        }
        if params
            .group
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
        {
            where_clauses.push("UPPER(COALESCE(p.pgroup,'')) = ?".into());
        }
        if params
            .make
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
        {
            where_clauses.push("EXISTS (SELECT 1 FROM product_vehicles pvm JOIN vehicles vm ON vm.id=pvm.vehicle_id WHERE pvm.product_id=p.id AND UPPER(TRIM(COALESCE(vm.make,''))) = ?)".into());
        }
        if params.vehicle_id.is_some() {
            // Match por id e também por nome do veículo em qualquer posição.
            where_clauses.push(
                "EXISTS (SELECT 1 FROM product_vehicles pv JOIN vehicles v2 ON v2.id=pv.vehicle_id WHERE pv.product_id=p.id AND (pv.vehicle_id = ? OR (? IS NOT NULL AND UPPER(v2.name) LIKE ?) OR (? IS NOT NULL AND UPPER(v2.name) LIKE ?)))"
                    .into(),
            );
        }
        if params
            .code_query
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
        {
            where_clauses.push(
                "(p.code LIKE ? OR COALESCE(p.oem,'') LIKE ? OR COALESCE(p.similar,'') LIKE ? OR EXISTS (SELECT 1 FROM product_vehicles pv3 JOIN vehicles v3 ON v3.id=pv3.vehicle_id WHERE pv3.product_id=p.id AND v3.name LIKE ?))"
                .into()
            );
        }
        if !where_clauses.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&where_clauses.join(" AND "));
        }
        sql.push_str(" ORDER BY b.name, p.description");
        if let Some(limit) = params.limit {
            sql.push_str(&format!(" LIMIT {}", limit));
        }

        let mut values: Vec<rusqlite::types::Value> = Vec::new();
        if let Some(b) = params.brand_id {
            values.push(b.into());
        }
        if let Some(g) = params.group.as_ref().filter(|s| !s.trim().is_empty()) {
            values.push(g.to_ascii_uppercase().into());
        }
        if let Some(mk) = params.make.as_ref().filter(|s| !s.trim().is_empty()) {
            values.push(mk.to_ascii_uppercase().into());
        }
        if let Some(v) = params.vehicle_id {
            values.push(v.into());
            // Passa o nome completo e tambÇ¸m o token inicial para permitir LIKE mais amplo
            if let Some(ref name) = vehicle_name {
                let upper = name.to_ascii_uppercase();
                values.push(upper.clone().into()); // nome completo para ? IS NOT NULL
                values.push(format!("%{}%", upper).into()); // match em qualquer posiÇõÇœo
            } else {
                values.push(rusqlite::types::Value::Null);
                values.push(rusqlite::types::Value::Null);
            }
            if let Some(ref token) = vehicle_token {
                values.push(token.clone().into()); // token para ? IS NOT NULL
                values.push(format!("%{}%", token).into());
            } else {
                values.push(rusqlite::types::Value::Null);
                values.push(rusqlite::types::Value::Null);
            }
        }
        if let Some(q) = params.code_query.as_ref().filter(|s| !s.trim().is_empty()) {
            let like = format!("%{}%", q);
            values.push(like.clone().into()); // code
            values.push(like.clone().into()); // oem
            values.push(like.clone().into()); // similar
            values.push(like.into()); // vehicle name
        }

        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query(rusqlite::params_from_iter(values))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            out.push(ProductListItem {
                id: row.get(0).map_err(|e| e.to_string())?,
                code: row.get(1).map_err(|e| e.to_string())?,
                description: row.get(2).map_err(|e| e.to_string())?,
                brand: row.get(3).map_err(|e| e.to_string())?,
                vehicles: row.get(4).ok(),
            });
        }
        Ok(out)
    }

    fn normalized_filter_values(values: Option<&Vec<String>>) -> Vec<String> {
        values
            .into_iter()
            .flatten()
            .map(|s| s.trim().to_ascii_uppercase())
            .filter(|s| !s.is_empty())
            .collect()
    }

    fn add_in_filter(
        where_clauses: &mut Vec<String>,
        values: &mut Vec<rusqlite::types::Value>,
        expr: &str,
        filter_values: Option<&Vec<String>>,
    ) {
        let vals = normalized_filter_values(filter_values);
        if vals.is_empty() {
            return;
        }
        let placeholders = std::iter::repeat("?")
            .take(vals.len())
            .collect::<Vec<_>>()
            .join(",");
        where_clauses.push(format!("{expr} IN ({placeholders})"));
        for value in vals {
            values.push(value.into());
        }
    }

    fn is_print_image_file(path: &Path) -> bool {
        let lower = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        lower.ends_with(".png")
            || lower.ends_with(".jpg")
            || lower.ends_with(".jpeg")
            || lower.ends_with(".webp")
            || lower.ends_with(".bmp")
            || lower.ends_with(".cimg")
    }

    fn print_image_priority(rel: &str) -> i32 {
        let lower = rel.to_ascii_lowercase();
        let mut priority = 0;
        if lower.ends_with(".cimg") {
            priority += 20;
        }
        if lower.contains("_sem_fundo") || lower.contains("-sem-fundo") {
            priority += 5;
        }
        if lower.contains("_1.") || lower.contains("-1.") {
            priority += 3;
        }
        priority
    }

    fn image_path_available(imgs_dir: &Path, path_or_rel: &str) -> bool {
        let trimmed = path_or_rel.trim();
        if trimmed.is_empty() {
            return false;
        }
        if is_launch_path(trimmed) {
            return false;
        }
        let path = PathBuf::from(trimmed);
        let resolved = if path.is_absolute() {
            path
        } else {
            imgs_dir.join(path)
        };
        if resolved.exists() {
            return true;
        }
        if !trimmed.to_ascii_lowercase().ends_with(".cimg") {
            return PathBuf::from(format!("{}.cimg", resolved.to_string_lossy())).exists();
        }
        false
    }

    fn local_image_code_map(imgs_dir: &Path) -> HashMap<String, String> {
        let mut best: HashMap<String, (i32, String)> = HashMap::new();
        if !imgs_dir.exists() {
            return HashMap::new();
        }

        for entry in WalkDir::new(imgs_dir).into_iter().filter_map(|e| e.ok()) {
            let path = entry.path();
            if !path.is_file() || !is_print_image_file(path) {
                continue;
            }
            let rel = pathdiff::diff_paths(path, imgs_dir).unwrap_or_else(|| path.to_path_buf());
            let rel = rel.to_string_lossy().replace('\\', "/");
            if is_launch_path(&rel) {
                continue;
            }
            let file_name = rel.rsplit('/').next().unwrap_or(&rel);
            let stem = file_name.split('.').next().unwrap_or(file_name);
            let priority = print_image_priority(&rel);
            for code in candidate_codes(stem) {
                match best.get(&code) {
                    Some((current_priority, current_rel))
                        if *current_priority < priority
                            || (*current_priority == priority && current_rel <= &rel) => {}
                    _ => {
                        best.insert(code, (priority, rel.clone()));
                    }
                }
            }
        }

        best.into_iter()
            .map(|(code, (_, rel))| (code, rel))
            .collect()
    }

    fn push_unique_text(list: &mut Vec<String>, value: String) {
        let clean = value.trim();
        if clean.is_empty() {
            return;
        }
        if !list.iter().any(|item| item.eq_ignore_ascii_case(clean)) {
            list.push(clean.to_string());
        }
    }

    fn excel_multiline_vehicles(value: &str) -> String {
        let mut vehicles = Vec::new();
        for raw in value.split(',') {
            push_unique_text(&mut vehicles, raw.trim().to_string());
        }
        vehicles.join("\n")
    }

    fn similar_codes_text(value: &str) -> String {
        let normalized = value.replace([',', ';', '|', '\n', '\r'], " ");
        let mut codes = Vec::new();
        for token in normalized.split_whitespace() {
            let clean = token.trim();
            if clean.is_empty() {
                continue;
            }
            if let Some((_, right)) = clean.split_once(':') {
                if !right.trim().is_empty() {
                    push_unique_text(&mut codes, right.trim().to_ascii_uppercase());
                }
                continue;
            }
            if clean.ends_with(':') {
                continue;
            }
            push_unique_text(&mut codes, clean.to_ascii_uppercase());
        }
        codes.join(" ")
    }

    fn excel_clean_concat(value: Option<String>) -> String {
        value
            .unwrap_or_default()
            .split(',')
            .map(|part| part.trim())
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("; ")
    }

    fn xml_escape(value: &str) -> String {
        value
            .chars()
            .map(|ch| match ch {
                '&' => "&amp;".to_string(),
                '<' => "&lt;".to_string(),
                '>' => "&gt;".to_string(),
                '"' => "&quot;".to_string(),
                '\'' => "&apos;".to_string(),
                _ => ch.to_string(),
            })
            .collect::<String>()
    }

    fn excel_col_name(mut index: usize) -> String {
        let mut name = String::new();
        index += 1;
        while index > 0 {
            let rem = (index - 1) % 26;
            name.insert(0, (b'A' + rem as u8) as char);
            index = (index - 1) / 26;
        }
        name
    }

    fn xlsx_sheet_xml(rows: &[Vec<String>]) -> String {
        let last_row = rows.len().max(1);
        let last_col = rows.first().map(|r| r.len()).unwrap_or(1).saturating_sub(1);
        let dimension = format!("A1:{}{}", excel_col_name(last_col), last_row);
        let mut xml = String::from(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#);
        xml.push_str(
            r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">"#,
        );
        xml.push_str(&format!(r#"<dimension ref="{}"/>"#, dimension));
        xml.push_str(r#"<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>"#);
        xml.push_str(r#"<cols><col min="1" max="1" width="18" customWidth="1"/><col min="2" max="2" width="18" customWidth="1"/><col min="3" max="3" width="32" customWidth="1"/><col min="4" max="4" width="64" customWidth="1"/><col min="5" max="5" width="48" customWidth="1"/><col min="6" max="6" width="38" customWidth="1"/></cols>"#);
        xml.push_str("<sheetData>");
        for (row_idx, row) in rows.iter().enumerate() {
            let row_num = row_idx + 1;
            xml.push_str(&format!(r#"<row r="{}">"#, row_num));
            for (col_idx, value) in row.iter().enumerate() {
                let cell_ref = format!("{}{}", excel_col_name(col_idx), row_num);
                let style = if row_idx == 0 { 1 } else { 2 };
                xml.push_str(&format!(
                    r#"<c r="{}" s="{}" t="inlineStr"><is><t xml:space="preserve">{}</t></is></c>"#,
                    cell_ref,
                    style,
                    xml_escape(value)
                ));
            }
            xml.push_str("</row>");
        }
        xml.push_str("</sheetData>");
        xml.push_str(&format!(r#"<autoFilter ref="{}"/>"#, dimension));
        xml.push_str("</worksheet>");
        xml
    }

    fn write_xlsx_file(path: &Path, rows: &[Vec<String>]) -> Result<(), String> {
        use std::io::Write;
        let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipWriter::new(file);
        let options =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let mut add = |name: &str, contents: &str| -> Result<(), String> {
            zip.start_file(name, options).map_err(|e| e.to_string())?;
            zip.write_all(contents.as_bytes())
                .map_err(|e| e.to_string())
        };
        add(
            "[Content_Types].xml",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>"#,
        )?;
        add(
            "_rels/.rels",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
        )?;
        add(
            "xl/workbook.xml",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Resultado" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
        )?;
        add(
            "xl/_rels/workbook.xml.rels",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#,
        )?;
        add(
            "xl/styles.xml",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><alignment wrapText="1" vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>"#,
        )?;
        add("xl/worksheets/sheet1.xml", &xlsx_sheet_xml(rows))?;
        zip.finish().map_err(|e| e.to_string())?;
        Ok(())
    }

    #[tauri::command]
    pub fn get_print_catalog_cmd(
        app: AppHandle,
        params: PrintCatalogParams,
    ) -> Result<Vec<PrintCatalogItem>, String> {
        let conn =
            open_db(&db_path(&app).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        migrate(&conn).map_err(|e| e.to_string())?;

        let vehicle_label_expr = "UPPER(TRIM(CASE WHEN INSTR(REPLACE(v.name,'/',' '),' ')>0 THEN SUBSTR(REPLACE(v.name,'/',' '),1,INSTR(REPLACE(v.name,'/',' '),' ')-1) ELSE v.name END))";
        let mut sql = String::from(
            "SELECT
                p.id,
                p.code,
                p.description,
                b.name,
                p.pgroup,
                NULLIF(MIN(TRIM(COALESCE(v.category,''))), ''),
                NULLIF(MIN(TRIM(COALESCE(v.make,''))), ''),
                MIN(TRIM(v.name)),
                NULLIF(TRIM(COALESCE(p.similar,'')), ''),
                (
                    SELECT i.filename
                    FROM images i
                    WHERE i.product_id = p.id
                      AND LOWER(REPLACE(i.filename,'\\','/')) NOT LIKE '%/lancamentos/%'
                    ORDER BY i.filename
                    LIMIT 1
                ) AS image
             FROM products p
             JOIN brands b ON b.id = p.brand_id
             JOIN product_vehicles pv ON pv.product_id = p.id
             JOIN vehicles v ON v.id = pv.vehicle_id",
        );
        let mut where_clauses: Vec<String> = Vec::new();
        let mut values: Vec<rusqlite::types::Value> = Vec::new();

        add_in_filter(
            &mut where_clauses,
            &mut values,
            "UPPER(TRIM(COALESCE(v.category,'')))",
            params.lines.as_ref(),
        );
        add_in_filter(
            &mut where_clauses,
            &mut values,
            "UPPER(TRIM(COALESCE(p.pgroup,'')))",
            params.groups.as_ref(),
        );
        add_in_filter(
            &mut where_clauses,
            &mut values,
            "UPPER(TRIM(COALESCE(v.make,'')))",
            params.makes.as_ref(),
        );
        add_in_filter(
            &mut where_clauses,
            &mut values,
            vehicle_label_expr,
            params.vehicles.as_ref(),
        );
        if params.launch_only {
            where_clauses.push(
                "(UPPER(COALESCE(p.pgroup,'')) LIKE '%LANC%' OR UPPER(COALESCE(p.details,'')) LIKE '%LANC%' OR EXISTS (SELECT 1 FROM images il WHERE il.product_id = p.id AND LOWER(REPLACE(il.filename,'\\','/')) LIKE '%/lancamentos/%'))"
                    .into(),
            );
        }
        // Ainda nao existe tabela/flag de favoritos no catalogo local; mantemos o campo
        // no contrato para ativar o filtro quando essa origem estiver disponivel.
        let _ = params.favorites_only;

        if !where_clauses.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&where_clauses.join(" AND "));
        }
        sql.push_str(" GROUP BY p.id");
        sql.push_str(
            " ORDER BY UPPER(TRIM(COALESCE(p.pgroup,''))), UPPER(TRIM(COALESCE(NULLIF(MIN(TRIM(COALESCE(v.make,''))), ''),''))), UPPER(TRIM(MIN(TRIM(v.name)))), UPPER(TRIM(p.description)), UPPER(TRIM(p.code))",
        );
        if let Some(limit) = params.limit.filter(|v| *v > 0) {
            sql.push_str(&format!(" LIMIT {}", limit));
        }

        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query(rusqlite::params_from_iter(values))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            out.push(PrintCatalogItem {
                product_id: row.get(0).map_err(|e| e.to_string())?,
                code: row.get(1).map_err(|e| e.to_string())?,
                description: row.get(2).map_err(|e| e.to_string())?,
                brand: row.get(3).map_err(|e| e.to_string())?,
                group: row.get(4).map_err(|e| e.to_string())?,
                line: row.get(5).map_err(|e| e.to_string())?,
                make: row.get(6).map_err(|e| e.to_string())?,
                vehicle: row.get(7).map_err(|e| e.to_string())?,
                similar: row.get(8).map_err(|e| e.to_string())?,
                image: row.get(9).map_err(|e| e.to_string())?,
            });
        }
        let (_data_dir, _db_file, imgs_dir) = ensure_dirs(&app).map_err(|e| e.to_string())?;
        if out.iter().any(|item| {
            item.image
                .as_ref()
                .map(|s| !image_path_available(&imgs_dir, s))
                .unwrap_or(true)
        }) {
            let image_by_code = local_image_code_map(&imgs_dir);
            for item in out.iter_mut() {
                let image_available = item
                    .image
                    .as_ref()
                    .map(|s| image_path_available(&imgs_dir, s))
                    .unwrap_or(false);
                if image_available {
                    continue;
                }
                let code_key = item.code.trim().to_ascii_uppercase();
                if let Some(rel) = image_by_code.get(&code_key) {
                    item.image = Some(rel.clone());
                } else {
                    item.image = None;
                }
            }
        }
        let mut unique_images = Vec::new();
        let mut seen_images = HashSet::new();
        for item in out.iter() {
            if let Some(img) = item
                .image
                .as_ref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
            {
                if seen_images.insert(img.to_string()) {
                    unique_images.push(img.to_string());
                }
            }
        }
        let prepared_images: HashMap<String, Option<String>> = if unique_images.is_empty() {
            HashMap::new()
        } else {
            let workers = std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(4)
                .clamp(2, 8)
                .min(unique_images.len());
            let chunk_size = (unique_images.len() + workers - 1) / workers;
            let prepared = Arc::new(Mutex::new(HashMap::new()));
            std::thread::scope(|scope| {
                for chunk in unique_images.chunks(chunk_size) {
                    let app_handle = app.clone();
                    let chunk = chunk.to_vec();
                    let prepared = Arc::clone(&prepared);
                    scope.spawn(move || {
                        for file in chunk {
                            let result =
                                crate::call_img::prepare_image_for_print(&app_handle, file.clone())
                                    .ok()
                                    .map(|p| p.to_string_lossy().into_owned());
                            if let Ok(mut map) = prepared.lock() {
                                map.insert(file, result);
                            }
                        }
                    });
                }
            });
            Arc::try_unwrap(prepared)
                .ok()
                .and_then(|m| m.into_inner().ok())
                .unwrap_or_default()
        };
        for item in out.iter_mut() {
            if let Some(img) = item.image.clone() {
                item.image = prepared_images.get(&img).cloned().unwrap_or(None);
            }
        }
        Ok(out)
    }

    #[tauri::command]
    pub fn export_print_excel_cmd(
        app: AppHandle,
        params: PrintCatalogParams,
        path: String,
    ) -> Result<ExcelExportResult, String> {
        let conn =
            open_db(&db_path(&app).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        migrate(&conn).map_err(|e| e.to_string())?;

        let vehicle_label_expr = "UPPER(TRIM(CASE WHEN INSTR(REPLACE(v.name,'/',' '),' ')>0 THEN SUBSTR(REPLACE(v.name,'/',' '),1,INSTR(REPLACE(v.name,'/',' '),' ')-1) ELSE v.name END))";
        let mut sql = String::from(
            "SELECT
                p.code,
                NULLIF(group_concat(DISTINCT TRIM(COALESCE(v.category,''))), ''),
                p.pgroup,
                group_concat(DISTINCT TRIM(v.name)),
                COALESCE(NULLIF(TRIM(COALESCE(p.details,'')), ''), NULLIF(TRIM(COALESCE(p.description,'')), ''), ''),
                NULLIF(TRIM(COALESCE(p.similar,'')), '')
             FROM products p
             JOIN brands b ON b.id = p.brand_id
             JOIN product_vehicles pv ON pv.product_id = p.id
             JOIN vehicles v ON v.id = pv.vehicle_id",
        );
        let mut where_clauses: Vec<String> = Vec::new();
        let mut values: Vec<rusqlite::types::Value> = Vec::new();

        add_in_filter(
            &mut where_clauses,
            &mut values,
            "UPPER(TRIM(COALESCE(v.category,'')))",
            params.lines.as_ref(),
        );
        add_in_filter(
            &mut where_clauses,
            &mut values,
            "UPPER(TRIM(COALESCE(p.pgroup,'')))",
            params.groups.as_ref(),
        );
        add_in_filter(
            &mut where_clauses,
            &mut values,
            "UPPER(TRIM(COALESCE(v.make,'')))",
            params.makes.as_ref(),
        );
        add_in_filter(
            &mut where_clauses,
            &mut values,
            vehicle_label_expr,
            params.vehicles.as_ref(),
        );
        if params.launch_only {
            where_clauses.push(
                "(UPPER(COALESCE(p.pgroup,'')) LIKE '%LANC%' OR UPPER(COALESCE(p.details,'')) LIKE '%LANC%' OR EXISTS (SELECT 1 FROM images il WHERE il.product_id = p.id AND LOWER(REPLACE(il.filename,'\\','/')) LIKE '%/lancamentos/%'))"
                    .into(),
            );
        }
        let _ = params.favorites_only;

        if !where_clauses.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&where_clauses.join(" AND "));
        }
        sql.push_str(" GROUP BY p.id");
        sql.push_str(
            " ORDER BY UPPER(TRIM(COALESCE(p.pgroup,''))), UPPER(TRIM(COALESCE(NULLIF(MIN(TRIM(COALESCE(v.make,''))), ''),''))), UPPER(TRIM(MIN(TRIM(v.name)))), UPPER(TRIM(p.description)), UPPER(TRIM(p.code))",
        );
        if let Some(limit) = params.limit.filter(|v| *v > 0) {
            sql.push_str(&format!(" LIMIT {}", limit));
        }

        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut query = stmt
            .query(rusqlite::params_from_iter(values))
            .map_err(|e| e.to_string())?;

        let mut rows = vec![vec![
            "CODIGO".to_string(),
            "LINHA".to_string(),
            "GRUPO".to_string(),
            "VEICULOS".to_string(),
            "DETALHES".to_string(),
            "SIMILARES".to_string(),
        ]];
        while let Some(row) = query.next().map_err(|e| e.to_string())? {
            let vehicles_raw: Option<String> = row.get(3).map_err(|e| e.to_string())?;
            let vehicles = excel_multiline_vehicles(&vehicles_raw.unwrap_or_default());
            let similar_raw: Option<String> = row.get(5).map_err(|e| e.to_string())?;
            rows.push(vec![
                row.get::<_, Option<String>>(0)
                    .map_err(|e| e.to_string())?
                    .unwrap_or_default(),
                excel_clean_concat(row.get(1).map_err(|e| e.to_string())?),
                row.get::<_, Option<String>>(2)
                    .map_err(|e| e.to_string())?
                    .unwrap_or_default(),
                vehicles,
                row.get::<_, Option<String>>(4)
                    .map_err(|e| e.to_string())?
                    .unwrap_or_default(),
                similar_codes_text(&similar_raw.unwrap_or_default()),
            ]);
        }

        let output = if path.to_ascii_lowercase().ends_with(".xlsx") {
            path
        } else {
            format!("{}.xlsx", path)
        };
        let dest = PathBuf::from(&output);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        write_xlsx_file(&dest, &rows)?;
        Ok(ExcelExportResult {
            rows: rows.len().saturating_sub(1),
            output,
        })
    }

    #[tauri::command]
    pub fn get_product_details_cmd(
        app: AppHandle,
        product_id: i64,
    ) -> Result<ProductDetails, String> {
        let conn =
            open_db(&db_path(&app).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("SELECT p.id, p.code, p.description, p.application, p.details, p.ean_gtin, p.altura, p.largura, p.comprimento, p.similar, b.name FROM products p JOIN brands b ON b.id = p.brand_id WHERE p.id = ?1").map_err(|e| e.to_string())?;
        let (
            id,
            code,
            description,
            application,
            details,
            ean_gtin,
            altura,
            largura,
            comprimento,
            similar,
            brand,
        ): (
            i64,
            String,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            String,
        ) = stmt
            .query_row(params![product_id], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                    row.get(10)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut img_stmt = conn
            .prepare("SELECT filename FROM images WHERE product_id = ?1 ORDER BY filename")
            .map_err(|e| e.to_string())?;
        let images: Vec<String> = img_stmt
            .query_map(params![product_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(ProductDetails {
            id,
            code,
            description,
            brand,
            application,
            details,
            ean_gtin,
            altura,
            largura,
            comprimento,
            similar,
            images,
        })
    }

    fn looks_like_catalog_asset(bytes: &[u8]) -> bool {
        bytes.starts_with(b"CIMG")
            || bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A])
            || bytes.starts_with(&[0xFF, 0xD8, 0xFF])
            || bytes.starts_with(b"GIF87a")
            || bytes.starts_with(b"GIF89a")
            || bytes.starts_with(b"BM")
            || (bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP")
    }

    fn write_download_bytes(dest: &Path, bytes: &[u8]) -> Result<()> {
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(dest, bytes)?;
        Ok(())
    }

    fn safe_manifest_rel_path(path: &str) -> Result<PathBuf> {
        let normalized = path.replace('\\', "/");
        let rel = Path::new(&normalized);
        if normalized.trim().is_empty() {
            anyhow::bail!("caminho vazio no manifest");
        }
        if rel.is_absolute() {
            anyhow::bail!("caminho absoluto no manifest: {}", path);
        }
        for component in rel.components() {
            match component {
                Component::Normal(_) => {}
                _ => anyhow::bail!("caminho invalido no manifest: {}", path),
            }
        }
        Ok(rel.to_path_buf())
    }

    fn sha256_file(path: &Path) -> Result<String> {
        let bytes = fs::read(path)?;
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let out = hasher.finalize();
        Ok(out.iter().map(|b| format!("{:02x}", b)).collect())
    }

    async fn download_to_file_raw(url: &str, dest: &Path) -> Result<()> {
        let raw_client = Client::builder()
            .timeout(Duration::from_secs(20))
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .no_zstd()
            .build()?;
        let resp = raw_client
            .get(url)
            .header(ACCEPT_ENCODING, "identity")
            .send()
            .await?
            .error_for_status()?;
        let bytes = resp.bytes().await?;
        if !looks_like_catalog_asset(bytes.as_ref()) {
            anyhow::bail!(
                "fallback bruto retornou payload inesperado para {}",
                dest.display()
            );
        }
        write_download_bytes(dest, bytes.as_ref())
    }

    async fn download_to_file(client: &Client, url: &str, dest: &Path) -> Result<()> {
        let resp = client.get(url).send().await?.error_for_status()?;
        let content_encoding = resp
            .headers()
            .get(CONTENT_ENCODING)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.to_string());
        let bytes = match resp.bytes().await {
            Ok(bytes) => bytes,
            Err(err) if err.is_decode() => {
                eprintln!(
                    "download_to_file: decode HTTP falhou para {} (content-encoding={:?}); tentando modo bruto: {}",
                    url,
                    content_encoding,
                    err
                );
                return download_to_file_raw(url, dest).await;
            }
            Err(err) => return Err(err.into()),
        };
        write_download_bytes(dest, bytes.as_ref())
    }

    async fn download_to_file_verified(
        client: &Client,
        url: &str,
        dest: &Path,
        expected_sha256: Option<&str>,
    ) -> Result<()> {
        let tmp = dest.with_extension("download.tmp");
        if tmp.exists() {
            let _ = fs::remove_file(&tmp);
        }
        download_to_file(client, url, &tmp).await?;
        if let Some(expected) = expected_sha256.map(|s| s.trim()).filter(|s| !s.is_empty()) {
            let actual = sha256_file(&tmp)?;
            if !actual.eq_ignore_ascii_case(expected) {
                let _ = fs::remove_file(&tmp);
                anyhow::bail!(
                    "sha256 invalido para {}: esperado {}, obtido {}",
                    dest.display(),
                    expected,
                    actual
                );
            }
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(&tmp, dest).or_else(|_| {
            fs::copy(&tmp, dest)?;
            fs::remove_file(&tmp)?;
            Ok::<(), std::io::Error>(())
        })?;
        Ok(())
    }

    fn index_from_file_list(conn: &mut Connection, files: &[String]) -> Result<ImageIndexResult> {
        let tx = conn.transaction()?;
        let mut scanned = 0usize;
        let mut matched = 0usize;
        let mut inserted = 0usize;
        // Limpa a tabela antes de reindexar para evitar associações antigas/erradas
        tx.execute("DELETE FROM images", [])?;
        for f in files {
            scanned += 1;
            // Usa apenas o ultimo segmento como nome de arquivo logico
            let rel = f.replace('\\', "/");
            let last = rel.rsplit('/').next().unwrap_or(&rel);
            let stem = last.split('.').next().unwrap_or(last);
            let candidates = candidate_codes(stem);
            let mut found: Option<i64> = None;
            for c in candidates {
                if let Ok(pid) =
                    tx.query_row("SELECT id FROM products WHERE code=?1", params![c], |r| {
                        r.get(0)
                    })
                {
                    found = Some(pid);
                    break;
                }
            }
            if let Some(pid) = found {
                matched += 1;
                if tx
                    .execute(
                        "INSERT OR IGNORE INTO images(product_id, filename) VALUES(?1,?2)",
                        params![pid, rel],
                    )
                    .is_ok()
                {
                    inserted += 1;
                }
            }
        }
        tx.commit()?;
        Ok(ImageIndexResult {
            scanned,
            matched,
            inserted,
        })
    }

    #[tauri::command]
    pub fn set_branding_image(kind: String, source_path: String) -> Result<BrandingResult, String> {
        use std::io::Write;
        let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
        let out_dir = if cwd.ends_with("src-tauri") {
            cwd.parent().unwrap_or(&cwd).join("public").join("images")
        } else {
            cwd.join("public").join("images")
        };
        fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
        let ext = std::path::Path::new(&source_path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("png");
        let fixed = if kind.to_lowercase().starts_with("logo") {
            format!("logo.{}", ext)
        } else {
            format!("bg.{}", ext)
        };
        let dest = out_dir.join(&fixed);
        fs::copy(&source_path, &dest).map_err(|e| e.to_string())?;
        let json_path = out_dir.join("branding.json");
        let mut logo: Option<String> = None;
        let mut background: Option<String> = None;
        let mut header_logos: Option<Vec<String>> = None;
        if json_path.exists() {
            if let Ok(bytes) = fs::read(&json_path) {
                if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                    logo = val
                        .get("logo")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    background = val
                        .get("background")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    header_logos = val
                        .get("headerLogos")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                                .collect::<Vec<String>>()
                        });
                }
            }
        }
        if kind.to_lowercase().starts_with("logo") {
            logo = Some(fixed.clone());
        } else {
            background = Some(fixed.clone());
        }
        let obj = serde_json::json!({ "logo": logo, "background": background, "headerLogos": header_logos });
        let mut f = std::fs::File::create(&json_path).map_err(|e| e.to_string())?;
        f.write_all(serde_json::to_string_pretty(&obj).unwrap().as_bytes())
            .map_err(|e| e.to_string())?;
        Ok(BrandingResult {
            ok: true,
            logo,
            background,
            header_logos,
        })
    }

    #[tauri::command]
    pub fn set_header_logos(paths: Vec<String>) -> Result<BrandingResult, String> {
        use std::io::Write;
        let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
        let out_dir = if cwd.ends_with("src-tauri") {
            cwd.parent().unwrap_or(&cwd).join("public").join("images")
        } else {
            cwd.join("public").join("images")
        };
        let logos_dir = out_dir.join("header-logos");
        fs::create_dir_all(&logos_dir).map_err(|e| e.to_string())?;

        let mut copied: Vec<String> = Vec::new();
        for p in paths.iter() {
            let src = std::path::Path::new(p);
            let _ext = src.extension().and_then(|e| e.to_str()).unwrap_or("png");
            let _ext = src.extension().and_then(|e| e.to_str()).unwrap_or("png");
            let name = src.file_name().and_then(|n| n.to_str()).unwrap_or("logo");
            let safe_name = name.replace(|c: char| c == '"' || c == '\'', "_");
            let dest = logos_dir.join(&safe_name);
            fs::copy(src, &dest).map_err(|e| format!("Falha ao copiar {}: {}", p, e))?;
            let rel = format!(
                "header-logos/{}",
                dest.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(safe_name.as_str())
            );
            if !copied.contains(&rel) {
                copied.push(rel);
            }
        }

        let json_path = out_dir.join("branding.json");
        let mut logo: Option<String> = None;
        let mut background: Option<String> = None;
        if json_path.exists() {
            if let Ok(bytes) = fs::read(&json_path) {
                if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                    logo = val
                        .get("logo")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    background = val
                        .get("background")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                }
            }
        }
        let obj =
            serde_json::json!({ "logo": logo, "background": background, "headerLogos": copied });
        let mut f = std::fs::File::create(&json_path).map_err(|e| e.to_string())?;
        f.write_all(serde_json::to_string_pretty(&obj).unwrap().as_bytes())
            .map_err(|e| e.to_string())?;
        Ok(BrandingResult {
            ok: true,
            logo,
            background,
            header_logos: Some(copied),
        })
    }

    #[tauri::command]
    pub async fn sync_from_manifest(
        app: AppHandle,
        manifest_url: String,
        skip_images: Option<bool>,
    ) -> Result<SyncResult, String> {
        let skip_images = skip_images.unwrap_or(false);
        let client = Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|e| e.to_string())?;
        let (data_dir, dbf, imgs_dir) = ensure_dirs(&app).map_err(|e| e.to_string())?;
        let (manifest, manifest_hash) =
            fetch_or_seed_manifest(&client, &app, &manifest_url).await?;
        let mut updated_db = false;
        let local_version = {
            let conn = open_db(&dbf).map_err(|e| e.to_string())?;
            migrate(&conn).map_err(|e| e.to_string())?;
            get_db_version(&conn).unwrap_or(0)
        };
        let manifest_changed = {
            let conn = open_db(&dbf).map_err(|e| e.to_string())?;
            migrate(&conn).ok();
            let last = get_manifest_hash(&conn).ok().flatten();
            last.as_deref() != Some(&manifest_hash)
        };
        if manifest.db.version > local_version {
            // Manifest mudou: limpar pasta de lancamentos para evitar resquicios antigos
            clear_launches_dir(&imgs_dir).ok();
            download_to_file_verified(
                &client,
                &manifest.db.url,
                &dbf,
                manifest.db.sha256.as_deref(),
            )
            .await
            .map_err(|e| e.to_string())?;
            let conn = open_db(&dbf).map_err(|e| e.to_string())?;
            migrate(&conn).map_err(|e| e.to_string())?;
            if get_db_version(&conn).unwrap_or(0) < manifest.db.version {
                set_db_version(&conn, manifest.db.version).ok();
            }
            updated_db = true;
        } else if manifest_changed {
            // Mesmo sem alterar o DB, se o manifest mudou (imagens novas), limpa lancamentos
            clear_launches_dir(&imgs_dir).ok();
        }
        let mut downloaded_images: usize = 0;
        if let Some(imgs) = manifest.images.clone() {
            if skip_images {
                let app_bg = app.clone();
                let client_bg = client.clone();
                let imgs_dir_bg = imgs_dir.clone();
                let db_bg = dbf.clone();
                tauri::async_runtime::spawn(async move {
                    let (down, errs) = download_images_sequential(
                        &client_bg,
                        &imgs_dir_bg,
                        &db_bg,
                        &imgs,
                        manifest_changed,
                    )
                    .await;
                    let _ = app_bg.emit(
                        "images_downloaded",
                        json!({ "downloaded": down, "errors": errs }),
                    );
                });
            } else {
                let (down, _errs) =
                    download_images_sequential(&client, &imgs_dir, &dbf, &imgs, manifest_changed)
                        .await;
                downloaded_images = down;
            }
        }
        let conn = open_db(&dbf).map_err(|e| e.to_string())?;
        seed_brand_groups(&conn).ok();
        set_manifest_hash(&conn, &manifest_hash).ok();
        let manifest_path = data_dir.join("manifest.json");
        if manifest_changed || !manifest_path.exists() {
            let _ = std::fs::write(
                &manifest_path,
                serde_json::to_string_pretty(&manifest).unwrap_or_default(),
            );
        }
        let final_version = get_db_version(&conn).unwrap_or(0);
        Ok(SyncResult {
            updated_db,
            downloaded_images,
            db_version: final_version,
        })
    }

    async fn download_images_sequential(
        client: &Client,
        imgs_dir: &Path,
        db_path: &Path,
        imgs: &ManifestImages,
        manifest_changed: bool,
    ) -> (usize, usize) {
        // Mantém a assinatura para compatibilidade, mas usa paralelismo controlado.
        let max_concurrency = std::env::var("IMG_CONCURRENCY")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|v| *v > 0)
            .unwrap_or(DEFAULT_IMG_CONCURRENCY);
        let semaphore = Arc::new(Semaphore::new(max_concurrency));
        let mut downloaded_images: usize = 0;
        let mut errors: usize = 0;

        // Avalia quem precisa ser baixado consultando cache local.
        let conn_cache = match open_db(db_path) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("Falha ao abrir cache de imagens: {}", e);
                return (0, 1);
            }
        };
        struct DownloadJob {
            url: String,
            local_path: std::path::PathBuf,
            rel_name: String,
            sha256: Option<String>,
        }
        let mut jobs: Vec<DownloadJob> = Vec::new();
        for item in imgs.files.iter() {
            let Ok(rel_path) = safe_manifest_rel_path(&item.file) else {
                eprintln!("Ignorando caminho invalido no manifest: {}", item.file);
                errors += 1;
                continue;
            };
            let local_path = imgs_dir.join(&rel_path);
            let mut need = !local_path.exists();
            if !need {
                if let Some(ref man_sha) = item.sha256 {
                    let cached: Option<String> = conn_cache
                        .query_row(
                            "SELECT sha256 FROM images_cache WHERE filename=?1",
                            params![&item.file],
                            |row| row.get(0),
                        )
                        .optional()
                        .unwrap_or(None);
                    if cached.as_deref() != Some(man_sha.as_str()) {
                        need = true;
                    }
                } else if manifest_changed {
                    need = true;
                }
            }
            if need {
                let url = if item.file.starts_with("http://") || item.file.starts_with("https://") {
                    item.file.clone()
                } else if let Ok(base) = url::Url::parse(&imgs.base_url) {
                    base.join(&item.file)
                        .map(|u| u.to_string())
                        .unwrap_or_else(|_| format!("{}{}", imgs.base_url, item.file))
                } else {
                    format!("{}{}", imgs.base_url, item.file)
                };
                jobs.push(DownloadJob {
                    url,
                    local_path,
                    rel_name: item.file.clone(),
                    sha256: item.sha256.clone(),
                });
            }
        }
        drop(conn_cache);

        let mut set = JoinSet::new();
        let semaphore_dl = semaphore.clone();
        for job in jobs {
            let client = client.clone();
            let sem = semaphore_dl.clone();
            set.spawn(async move {
                // Respeita limite de concorrência.
                let _permit = sem.acquire_owned().await.ok();
                if let Some(parent) = job.local_path.parent() {
                    if !parent.exists() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                }
                match download_to_file(&client, &job.url, &job.local_path).await {
                    Ok(_) => Ok((job.rel_name, job.sha256)),
                    Err(e) => Err((job.rel_name, e.to_string())),
                }
            });
        }

        let mut cache_updates: Vec<(String, String)> = Vec::new();
        while let Some(res) = set.join_next().await {
            match res {
                Ok(Ok((rel, sha))) => {
                    downloaded_images += 1;
                    if let Some(s) = sha {
                        cache_updates.push((rel, s));
                    }
                }
                Ok(Err((rel, err))) => {
                    eprintln!("Falha ao baixar imagem {}: {}", rel, err);
                    errors += 1;
                }
                Err(e) => {
                    eprintln!("Task de download falhou: {}", e);
                    errors += 1;
                }
            }
        }

        // Atualiza cache de hashes após os downloads concluírem.
        if let Ok(conn) = open_db(db_path) {
            for (rel, sha) in cache_updates {
                let _ = conn.execute(
                    "INSERT OR REPLACE INTO images_cache(filename, sha256) VALUES(?1, ?2)",
                    params![&rel, &sha],
                );
            }
        }

        (downloaded_images, errors)
    }

    fn clear_launches_dir(imgs_dir: &std::path::Path) -> std::io::Result<()> {
        for entry in std::fs::read_dir(imgs_dir)? {
            if let Ok(e) = entry {
                let path = e.path();
                if path.is_dir() {
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        if is_launch_component(name) {
                            let _ = std::fs::remove_dir_all(&path);
                        }
                    }
                }
            }
        }
        Ok(())
    }

    #[tauri::command]
    pub fn list_launch_images(app: AppHandle) -> Result<Vec<String>, String> {
        use std::path::PathBuf;
        use walkdir::WalkDir;
        let (_, _dbf, imgs_dir) = ensure_dirs(&app).map_err(|e| e.to_string())?;
        let mut launch_dir: Option<PathBuf> = None;
        for entry in std::fs::read_dir(&imgs_dir).map_err(|e| e.to_string())? {
            if let Ok(e) = entry {
                let p = e.path();
                if p.is_dir() {
                    if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                        if is_launch_component(name) {
                            launch_dir = Some(p);
                            break;
                        }
                    }
                }
            }
        }
        let dir = match launch_dir {
            Some(d) => d,
            None => return Ok(vec![]),
        };
        let allow = ["jpg", "jpeg", "png", "webp", "gif", "bmp"];
        let mut files: Vec<String> = WalkDir::new(&dir)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_file())
            .filter(|e| {
                e.path()
                    .extension()
                    .and_then(|ex| ex.to_str())
                    .map(|s| {
                        let lower = s.to_ascii_lowercase();
                        allow.contains(&lower.as_str())
                    })
                    .unwrap_or(false)
            })
            .map(|e| e.path().to_string_lossy().to_string())
            .collect();
        files.sort();
        Ok(files)
    }

    #[tauri::command]
    pub fn open_path_cmd(path: String) -> Result<(), String> {
        open::that(path).map_err(|e| e.to_string())
    }

    fn find_app_root_upwards(start: &Path, max_levels: usize) -> Option<PathBuf> {
        for dir in start.ancestors().take(max_levels + 1) {
            if dir.join("package.json").exists()
                && dir.join("src-tauri").join("Cargo.toml").exists()
                && dir.join("src-tauri").join("tauri.conf.json").exists()
            {
                return Some(dir.to_path_buf());
            }
        }
        None
    }

    fn find_file_upwards(start: &Path, file_name: &str, max_levels: usize) -> Option<PathBuf> {
        let mut current = Some(start);
        for _ in 0..=max_levels {
            let dir = current?;
            let candidate = dir.join(file_name);
            if candidate.exists() {
                return Some(candidate);
            }
            current = dir.parent();
        }
        None
    }

    fn read_command_line(path: &Path) -> Result<String, String> {
        let contents = std::fs::read_to_string(path)
            .map_err(|e| format!("Falha ao ler {}: {}", path.display(), e))?;
        contents
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with("//"))
            .map(|line| line.to_string())
            .ok_or_else(|| format!("Nenhum comando valido encontrado em {}", path.display()))
    }

    fn validate_version_string(version: &str) -> Result<String, String> {
        let normalized = version.trim();
        if normalized.is_empty() {
            return Err("Informe uma versao".to_string());
        }
        if !normalized
            .chars()
            .next()
            .map(|c| c.is_ascii_digit())
            .unwrap_or(false)
        {
            return Err("A versao precisa comecar com numero".to_string());
        }
        if normalized.chars().any(|c| c.is_whitespace()) {
            return Err("A versao nao pode conter espacos".to_string());
        }
        if normalized
            .chars()
            .any(|c| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+')))
        {
            return Err(
                "Use apenas letras, numeros, ponto, hifen e sinal de mais na versao".to_string(),
            );
        }
        Ok(normalized.to_string())
    }

    fn extract_quoted_value(line: &str) -> Option<String> {
        let start = line.find('"')?;
        let rest = &line[start + 1..];
        let end = rest.find('"')?;
        Some(rest[..end].to_string())
    }

    fn read_json_version(path: &Path) -> Result<String, String> {
        let raw = std::fs::read_to_string(path)
            .map_err(|e| format!("Falha ao ler {}: {}", path.display(), e))?;
        let parsed: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|e| format!("Falha ao interpretar {}: {}", path.display(), e))?;
        parsed
            .get("version")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string())
            .ok_or_else(|| format!("Campo version nao encontrado em {}", path.display()))
    }

    fn read_cargo_toml_version(path: &Path) -> Result<String, String> {
        let raw = std::fs::read_to_string(path)
            .map_err(|e| format!("Falha ao ler {}: {}", path.display(), e))?;
        let mut in_package = false;
        for line in raw.lines() {
            let trimmed = line.trim();
            if trimmed == "[package]" {
                in_package = true;
                continue;
            }
            if in_package && trimmed.starts_with('[') && trimmed != "[package]" {
                break;
            }
            if in_package && trimmed.starts_with("version") {
                return extract_quoted_value(trimmed)
                    .ok_or_else(|| format!("Linha de versao invalida em {}", path.display()));
            }
        }
        Err(format!(
            "Campo version nao encontrado na secao [package] de {}",
            path.display()
        ))
    }

    fn read_cargo_lock_version(path: &Path, package_name: &str) -> Result<Option<String>, String> {
        if !path.exists() {
            return Ok(None);
        }
        let raw = std::fs::read_to_string(path)
            .map_err(|e| format!("Falha ao ler {}: {}", path.display(), e))?;
        let mut in_package = false;
        let mut current_name: Option<String> = None;
        for line in raw.lines() {
            let trimmed = line.trim();
            if trimmed == "[[package]]" {
                in_package = true;
                current_name = None;
                continue;
            }
            if in_package && trimmed.starts_with("[[") && trimmed != "[[package]]" {
                in_package = false;
                current_name = None;
                continue;
            }
            if !in_package {
                continue;
            }
            if trimmed.starts_with("name") {
                current_name = extract_quoted_value(trimmed);
                continue;
            }
            if current_name.as_deref() == Some(package_name) && trimmed.starts_with("version") {
                return Ok(extract_quoted_value(trimmed));
            }
        }
        Ok(None)
    }

    fn render_with_original_newline(lines: Vec<String>, original: &str) -> String {
        let newline = if original.contains("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        let mut rendered = lines.join(newline);
        if original.ends_with("\r\n") {
            rendered.push_str("\r\n");
        } else if original.ends_with('\n') {
            rendered.push('\n');
        }
        rendered
    }

    fn replace_first_json_version(contents: &str, new_version: &str) -> Result<String, String> {
        let mut replaced = false;
        let mut lines = Vec::new();
        for line in contents.lines() {
            let trimmed = line.trim_start();
            if !replaced && trimmed.starts_with("\"version\"") {
                let indent_len = line.len() - trimmed.len();
                let indent = &line[..indent_len];
                let suffix = if trimmed.trim_end().ends_with(',') {
                    ","
                } else {
                    ""
                };
                lines.push(format!("{indent}\"version\": \"{new_version}\"{suffix}"));
                replaced = true;
            } else {
                lines.push(line.to_string());
            }
        }
        if !replaced {
            return Err("Campo version nao encontrado no JSON".to_string());
        }
        Ok(render_with_original_newline(lines, contents))
    }

    fn replace_cargo_toml_version(contents: &str, new_version: &str) -> Result<String, String> {
        let mut replaced = false;
        let mut in_package = false;
        let mut lines = Vec::new();
        for line in contents.lines() {
            let trimmed = line.trim_start();
            let line_to_push = if trimmed == "[package]" {
                in_package = true;
                line.to_string()
            } else if in_package && trimmed.starts_with('[') && trimmed != "[package]" {
                in_package = false;
                line.to_string()
            } else if in_package && !replaced && trimmed.starts_with("version") {
                let indent_len = line.len() - trimmed.len();
                let indent = &line[..indent_len];
                replaced = true;
                format!("{indent}version = \"{new_version}\"")
            } else {
                line.to_string()
            };
            lines.push(line_to_push);
        }
        if !replaced {
            return Err("Campo version nao encontrado na secao [package]".to_string());
        }
        Ok(render_with_original_newline(lines, contents))
    }

    fn replace_cargo_lock_package_version(
        contents: &str,
        package_name: &str,
        new_version: &str,
    ) -> Result<Option<String>, String> {
        let mut replaced = false;
        let mut in_package = false;
        let mut current_name: Option<String> = None;
        let mut lines = Vec::new();
        for line in contents.lines() {
            let trimmed = line.trim_start();
            let line_to_push = if trimmed == "[[package]]" {
                in_package = true;
                current_name = None;
                line.to_string()
            } else if in_package && trimmed.starts_with("[[") && trimmed != "[[package]]" {
                in_package = false;
                current_name = None;
                line.to_string()
            } else if in_package && trimmed.starts_with("name") {
                current_name = extract_quoted_value(trimmed);
                line.to_string()
            } else if in_package
                && !replaced
                && current_name.as_deref() == Some(package_name)
                && trimmed.starts_with("version")
            {
                let indent_len = line.len() - trimmed.len();
                let indent = &line[..indent_len];
                replaced = true;
                format!("{indent}version = \"{new_version}\"")
            } else {
                line.to_string()
            };
            lines.push(line_to_push);
        }
        if !replaced {
            return Ok(None);
        }
        Ok(Some(render_with_original_newline(lines, contents)))
    }

    fn read_app_version_info() -> Result<AppVersionInfo, String> {
        let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
        let app_root = find_app_root_upwards(&cwd, 8)
            .ok_or_else(|| format!("Raiz do app nao encontrada a partir de {}", cwd.display()))?;
        let package_json_path = app_root.join("package.json");
        let cargo_toml_path = app_root.join("src-tauri").join("Cargo.toml");
        let tauri_conf_path = app_root.join("src-tauri").join("tauri.conf.json");
        let cargo_lock_path = app_root.join("src-tauri").join("Cargo.lock");

        let package_json_version = read_json_version(&package_json_path)?;
        let cargo_toml_version = read_cargo_toml_version(&cargo_toml_path)?;
        let tauri_conf_version = read_json_version(&tauri_conf_path)?;
        let cargo_lock_version = read_cargo_lock_version(&cargo_lock_path, "catalogo_ips")?;

        let consistent = package_json_version == cargo_toml_version
            && package_json_version == tauri_conf_version
            && cargo_lock_version
                .as_ref()
                .map(|v| v == &package_json_version)
                .unwrap_or(true);

        Ok(AppVersionInfo {
            resolved_version: package_json_version.clone(),
            consistent,
            package_json_version,
            cargo_toml_version,
            tauri_conf_version,
            cargo_lock_version,
            app_root: app_root.display().to_string(),
        })
    }

    fn split_command_line(input: &str) -> Result<Vec<String>, String> {
        let mut parts = Vec::new();
        let mut current = String::new();
        let mut in_single = false;
        let mut in_double = false;

        for ch in input.chars() {
            match ch {
                '\'' if !in_double => in_single = !in_single,
                '"' if !in_single => in_double = !in_double,
                c if c.is_whitespace() && !in_single && !in_double => {
                    if !current.is_empty() {
                        parts.push(std::mem::take(&mut current));
                    }
                }
                _ => current.push(ch),
            }
        }

        if in_single || in_double {
            return Err("Aspas nao fechadas no comando do rclone".to_string());
        }
        if !current.is_empty() {
            parts.push(current);
        }
        if parts.is_empty() {
            return Err("Comando do rclone vazio".to_string());
        }
        Ok(parts)
    }

    fn validate_rclone_command(parts: &[String]) -> Result<(), String> {
        let executable = Path::new(&parts[0])
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(parts[0].as_str())
            .to_ascii_lowercase();
        if executable != "rclone" && executable != "rclone.exe" {
            return Err("O comando em rclone.txt precisa iniciar com rclone".to_string());
        }
        if parts
            .get(1)
            .map(|arg| arg.eq_ignore_ascii_case("sync"))
            .unwrap_or(false)
        {
            Ok(())
        } else {
            Err("O comando em rclone.txt precisa usar a operacao sync".to_string())
        }
    }

    #[tauri::command]
    pub async fn gen_manifest_r2(
        _app: AppHandle,
        version: i64,
        db_url: String,
        out_path: String,
        r2: R2Creds,
    ) -> Result<String, String> {
        // Executa o script Node local para gerar o manifest a partir do R2
        let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
        // Resolve caminho do script considerando dev (../scripts) ou raiz (scripts)
        let script_path = if cwd.ends_with("src-tauri") {
            cwd.parent()
                .unwrap_or(&cwd)
                .join("scripts")
                .join("gen-manifest-r2.mjs")
        } else {
            cwd.join("scripts").join("gen-manifest-r2.mjs")
        };
        if !script_path.exists() {
            return Err(format!("Script nao encontrado: {}", script_path.display()));
        }
        let mut cmd = PCommand::new("node");
        cmd.arg(script_path.as_os_str())
            .arg("--version")
            .arg(version.to_string())
            .arg("--db-url")
            .arg(&db_url)
            .arg("--out")
            .arg(&out_path);
        // Env do R2:  define variaveis se valores nao estiverem vazios,
        // permitindo que o script leia de .env/.env.development quando nao passadas pela UI.
        if !r2.account_id.trim().is_empty() {
            cmd.env("R2_ACCOUNT_ID", &r2.account_id);
        }
        if !r2.bucket.trim().is_empty() {
            cmd.env("R2_BUCKET", &r2.bucket);
        }
        if !r2.access_key_id.trim().is_empty() {
            cmd.env("R2_ACCESS_KEY_ID", &r2.access_key_id);
        }
        if !r2.secret_access_key.trim().is_empty() {
            cmd.env("R2_SECRET_ACCESS_KEY", &r2.secret_access_key);
        }
        if let Some(ep) = r2.endpoint.as_ref() {
            if !ep.trim().is_empty() {
                cmd.env("R2_ENDPOINT", ep);
            }
        }
        if let Some(pub_url) = r2.public_base_url.as_ref() {
            if !pub_url.trim().is_empty() {
                cmd.env("R2_PUBLIC_BASE_URL", pub_url);
            }
        }
        let project_root: std::path::PathBuf = if cwd.ends_with("src-tauri") {
            cwd.parent().unwrap_or(&cwd).to_path_buf()
        } else {
            cwd.clone()
        };
        cmd.current_dir(&project_root);
        let output = cmd
            .output()
            .map_err(|e| format!("Falha ao iniciar Node: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            return Err(format!("Manifest R2 falhou: {}\n{}", stderr, stdout));
        }
        Ok(out_path)
    }

    #[tauri::command]
    pub async fn run_rclone_sync() -> Result<RcloneSyncResult, String> {
        let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
        let command_file = find_file_upwards(&cwd, "rclone.txt", 6).ok_or_else(|| {
            format!(
                "Arquivo rclone.txt nao encontrado a partir de {}",
                cwd.display()
            )
        })?;
        let command_line = read_command_line(&command_file)?;
        let parts = split_command_line(&command_line)?;
        validate_rclone_command(&parts)?;

        let executable = parts[0].clone();
        let args: Vec<String> = parts[1..].to_vec();
        let workdir = command_file
            .parent()
            .map(|dir| dir.to_path_buf())
            .unwrap_or_else(|| cwd.clone());

        let status = tokio::task::spawn_blocking(move || {
            let mut cmd = PCommand::new(&executable);
            cmd.args(&args)
                .current_dir(&workdir)
                .stdin(Stdio::null())
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit());
            cmd.status()
                .map_err(|e| format!("Falha ao iniciar rclone: {}", e))
        })
        .await
        .map_err(|e| format!("Falha ao aguardar processo do rclone: {}", e))??;

        Ok(RcloneSyncResult {
            ok: status.success(),
            exit_code: status.code(),
            command_file: command_file.display().to_string(),
        })
    }

    #[tauri::command]
    pub fn get_app_version_config() -> Result<AppVersionInfo, String> {
        read_app_version_info()
    }

    #[tauri::command]
    pub fn set_app_version_config(version: String) -> Result<AppVersionInfo, String> {
        let next_version = validate_version_string(&version)?;
        let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
        let app_root = find_app_root_upwards(&cwd, 8)
            .ok_or_else(|| format!("Raiz do app nao encontrada a partir de {}", cwd.display()))?;
        let package_json_path = app_root.join("package.json");
        let cargo_toml_path = app_root.join("src-tauri").join("Cargo.toml");
        let tauri_conf_path = app_root.join("src-tauri").join("tauri.conf.json");
        let cargo_lock_path = app_root.join("src-tauri").join("Cargo.lock");

        let package_json_raw = std::fs::read_to_string(&package_json_path)
            .map_err(|e| format!("Falha ao ler {}: {}", package_json_path.display(), e))?;
        let cargo_toml_raw = std::fs::read_to_string(&cargo_toml_path)
            .map_err(|e| format!("Falha ao ler {}: {}", cargo_toml_path.display(), e))?;
        let tauri_conf_raw = std::fs::read_to_string(&tauri_conf_path)
            .map_err(|e| format!("Falha ao ler {}: {}", tauri_conf_path.display(), e))?;

        let package_json_updated = replace_first_json_version(&package_json_raw, &next_version)?;
        let cargo_toml_updated = replace_cargo_toml_version(&cargo_toml_raw, &next_version)?;
        let tauri_conf_updated = replace_first_json_version(&tauri_conf_raw, &next_version)?;

        std::fs::write(&package_json_path, package_json_updated)
            .map_err(|e| format!("Falha ao gravar {}: {}", package_json_path.display(), e))?;
        std::fs::write(&cargo_toml_path, cargo_toml_updated)
            .map_err(|e| format!("Falha ao gravar {}: {}", cargo_toml_path.display(), e))?;
        std::fs::write(&tauri_conf_path, tauri_conf_updated)
            .map_err(|e| format!("Falha ao gravar {}: {}", tauri_conf_path.display(), e))?;

        if cargo_lock_path.exists() {
            let cargo_lock_raw = std::fs::read_to_string(&cargo_lock_path)
                .map_err(|e| format!("Falha ao ler {}: {}", cargo_lock_path.display(), e))?;
            if let Some(cargo_lock_updated) =
                replace_cargo_lock_package_version(&cargo_lock_raw, "catalogo_ips", &next_version)?
            {
                std::fs::write(&cargo_lock_path, cargo_lock_updated)
                    .map_err(|e| format!("Falha ao gravar {}: {}", cargo_lock_path.display(), e))?;
            }
        }

        read_app_version_info()
    }

    #[tauri::command]
    pub fn read_image_base64(app: AppHandle, path_or_rel: String) -> Result<String, String> {
        crate::call_img::read_image_base64(&app, path_or_rel)
    }

    #[tauri::command]
    pub fn save_pdf_base64(path: String, data_base64: String) -> Result<(), String> {
        use base64::Engine;
        if !path.to_ascii_lowercase().ends_with(".pdf") {
            return Err("Destino precisa ter extensao .pdf".to_string());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data_base64.trim())
            .map_err(|e| format!("PDF invalido: {}", e))?;
        if !bytes.starts_with(b"%PDF-") {
            return Err("Conteudo nao parece ser um PDF valido.".to_string());
        }
        let dest = PathBuf::from(&path);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&dest, bytes).map_err(|e| format!("Falha ao salvar PDF: {}", e))?;
        Ok(())
    }

    #[tauri::command]
    pub async fn index_images_from_manifest(
        app: AppHandle,
        manifest_url: String,
    ) -> Result<ImageIndexResult, String> {
        let client = Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|e| e.to_string())?;
        let (_, dbf, _) = ensure_dirs(&app).map_err(|e| e.to_string())?;
        let (manifest, _manifest_hash) =
            fetch_or_seed_manifest(&client, &app, &manifest_url).await?;
        let files: Vec<String> = if let Some(imgs) = manifest.images {
            imgs.files.into_iter().map(|it| it.file).collect()
        } else {
            Vec::new()
        };
        let mut conn = open_db(&dbf).map_err(|e| e.to_string())?;
        migrate(&conn).map_err(|e| e.to_string())?;
        index_from_file_list(&mut conn, &files).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn cleanup_images_from_manifest(
        app: AppHandle,
        manifest_url: String,
    ) -> Result<CleanupResult, String> {
        let client = Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|e| e.to_string())?;
        let (manifest, _manifest_hash) =
            fetch_or_seed_manifest(&client, &app, &manifest_url).await?;
        let imgs = manifest
            .images
            .ok_or_else(|| "Manifest nao possui bloco de imagens".to_string())?;
        let mut manifest_files: HashSet<String> = HashSet::new();
        for item in imgs.files.iter() {
            if safe_manifest_rel_path(&item.file).is_ok() {
                manifest_files.insert(normalize_rel_path(&item.file));
            }
        }
        if manifest_files.is_empty() {
            return Err(
                "Manifest sem arquivos de imagens; abortando limpeza para evitar remocao total"
                    .to_string(),
            );
        }

        let (_, _dbf, imgs_dir) = ensure_dirs(&app).map_err(|e| e.to_string())?;
        let mut removed = 0usize;
        let mut kept = 0usize;
        let mut total = 0usize;

        for entry in WalkDir::new(&imgs_dir).into_iter().filter_map(|e| e.ok()) {
            if entry.path().is_dir() {
                continue;
            }
            total += 1;
            let rel = entry
                .path()
                .strip_prefix(&imgs_dir)
                .unwrap_or(entry.path())
                .to_string_lossy()
                .to_string();
            let rel_norm = normalize_rel_path(&rel);
            if manifest_files.contains(&rel_norm) {
                kept += 1;
                continue;
            }
            if let Err(e) = std::fs::remove_file(entry.path()) {
                eprintln!(
                    "cleanup_images_from_manifest: falha ao remover {}: {}",
                    entry.path().display(),
                    e
                );
            } else {
                removed += 1;
            }
        }

        Ok(CleanupResult {
            removed_files: removed,
            kept_files: kept,
            total_scanned: total,
            manifest_files: manifest_files.len(),
        })
    }

    // Tenta baixar manifest por HTTP; se falhar, usa seed do bundle (manifest.json em resources).
    async fn fetch_or_seed_manifest(
        client: &Client,
        app: &AppHandle,
        manifest_url: &str,
    ) -> Result<(CatalogManifest, String), String> {
        // Se nao for http(s), tenta ler como arquivo local
        if !(manifest_url.starts_with("http://") || manifest_url.starts_with("https://")) {
            let txt = std::fs::read_to_string(manifest_url)
                .map_err(|e| format!("Falha lendo manifest local: {}", e))?;
            let h = hash_str(&txt);
            let m: CatalogManifest = serde_json::from_str(&txt)
                .map_err(|e| format!("Falha parse manifest local: {}", e))?;
            return Ok((m, h));
        }
        let http_res = client
            .get(manifest_url)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| e.to_string());
        match http_res {
            Ok(resp) => {
                let txt = resp.text().await.map_err(|e| e.to_string())?;
                let h = hash_str(&txt);
                let m: CatalogManifest = serde_json::from_str(&txt).map_err(|e| e.to_string())?;
                Ok((m, h))
            }
            Err(_e) => {
                // Fallback seed do bundle
                if let Ok(res_dir) = app.path().resource_dir() {
                    let p = res_dir.join("manifest.json");
                    if p.exists() {
                        let txt = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
                        let h = hash_str(&txt);
                        let m: CatalogManifest =
                            serde_json::from_str(&txt).map_err(|e| e.to_string())?;
                        return Ok((m, h));
                    }
                }
                Err("Falha ao obter manifest e sem seed local".to_string())
            }
        }
    }

    fn hash_str(txt: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(txt.as_bytes());
        let out = hasher.finalize();
        out.iter().map(|b| format!("{:02x}", b)).collect()
    }

    #[tauri::command]
    pub fn export_db_to(app: AppHandle, dest_path: String) -> Result<ExportResult, String> {
        let (_, dbf, _) = ensure_dirs(&app).map_err(|e| e.to_string())?;
        let dest = std::path::PathBuf::from(&dest_path);
        if dest.exists() {
            std::fs::remove_file(&dest)
                .map_err(|e| format!("Falha ao remover destino existente: {}", e))?;
        }
        let conn = open_db(&dbf).map_err(|e| e.to_string())?;
        let quoted = dest.to_string_lossy().replace('"', "\\\"");
        let sql = format!("VACUUM INTO \"{}\"", quoted);
        if let Err(e) = conn.execute(&sql, []) {
            return Err(format!("Falha no VACUUM INTO: {}", e));
        }
        Ok(ExportResult {
            ok: true,
            output: dest_path,
        })
    }

    #[tauri::command]
    pub fn import_excel(
        app: AppHandle,
        path: String,
    ) -> Result<crate::importer::ImportResult, String> {
        crate::importer::import_excel(app, path)
    }
    fn candidate_codes(stem: &str) -> Vec<String> {
        use std::collections::HashSet;
        let s = stem.trim();
        let up = s.to_ascii_uppercase();
        let mut set: HashSet<String> = HashSet::new();

        // original
        if !up.is_empty() {
            set.insert(up.clone());
        }

        // primeiro separador comum
        for sep in ['_', '-', ' '] {
            if let Some((first, _)) = up.split_once(sep) {
                if !first.is_empty() {
                    set.insert(first.to_string());
                }
            }
        }

        // somente caracteres alfanumericos
        let only_alnum: String = up.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
        if !only_alnum.is_empty() {
            set.insert(only_alnum.clone());
        }

        // prefixo numerico continuo (ex.: "7111043002LE" -> "7111043002")
        let digits_prefix: String = up.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !digits_prefix.is_empty() {
            set.insert(digits_prefix);
        }

        // retorna em ordem deterministica
        let mut out: Vec<String> = set.into_iter().collect();
        out.sort();
        out
    }

    #[tauri::command]
    pub fn index_images(app: AppHandle, root: String) -> Result<ImageIndexResult, String> {
        let (_, dbf, _imgs_dir) = ensure_dirs(&app).map_err(|e| e.to_string())?;
        let mut conn = open_db(&dbf).map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;

        let root_path = std::path::PathBuf::from(&root);
        let mut scanned = 0usize;
        let mut matched = 0usize;
        let mut inserted = 0usize;
        for entry in WalkDir::new(&root_path).into_iter().filter_map(|e| e.ok()) {
            if !entry.file_type().is_file() {
                continue;
            }
            let p = entry.path();
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .map(|s| s.to_ascii_lowercase())
                .unwrap_or_default();
            if !["jpg", "jpeg", "png", "webp", "bmp"].contains(&ext.as_str()) {
                continue;
            }
            scanned += 1;
            let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let candidates = candidate_codes(stem);
            let mut found: Option<i64> = None;
            for c in candidates {
                let res: Result<i64, _> =
                    tx.query_row("SELECT id FROM products WHERE code=?1", params![c], |r| {
                        r.get(0)
                    });
                if let Ok(pid) = res {
                    found = Some(pid);
                    break;
                }
            }
            if let Some(pid) = found {
                matched += 1;
                let rel = pathdiff::diff_paths(p, &root_path).unwrap_or_else(|| p.to_path_buf());
                let rel_str = rel.to_string_lossy().replace('\\', "/");
                if tx
                    .execute(
                        "INSERT OR IGNORE INTO images(product_id, filename) VALUES(?1,?2)",
                        params![pid, rel_str],
                    )
                    .is_ok()
                {
                    inserted += 1;
                }
            }
        }
        tx.commit().ok();
        Ok(ImageIndexResult {
            scanned,
            matched,
            inserted,
        })
    }
}

// Re-export types for the frontend typings (via invoke JSON)
pub use core::{CatalogManifest, InitInfo, SyncResult};

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            core::get_print_catalog_cmd,
            core::export_print_excel_cmd,
            core::get_product_details_cmd,
            core::sync_from_manifest,
            core::index_images_from_manifest,
            core::cleanup_images_from_manifest,
            core::list_launch_images,
            core::import_excel,
            core::index_images,
            core::export_db_to,
            core::open_path_cmd,
            core::set_branding_image,
            core::set_header_logos,
            core::gen_manifest_r2,
            core::run_rclone_sync,
            core::get_app_version_config,
            core::set_app_version_config,
            core::read_image_base64,
            core::save_pdf_base64
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
