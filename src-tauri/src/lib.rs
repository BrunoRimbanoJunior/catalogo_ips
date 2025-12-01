use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};
use tauri::Manager;

mod db;
mod importer;
mod desc;

mod core {
    use super::*;
    use base64::Engine;
    use reqwest::Client;
    use rusqlite::{params, Connection, OptionalExtension};
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::fs::File;
    use std::io::{self, copy};
    use std::path::Path;
    use std::sync::OnceLock;
    use std::time::Duration;
    use tauri::AppHandle;
    use walkdir::WalkDir;
    use zip::ZipArchive;
    use crate::db::{db_path, ensure_dirs, open_db, META_DB_VERSION_KEY, META_MANIFEST_HASH_KEY};

    const GROUP_EXPR_SQL: &str = "UPPER(TRIM(COALESCE(pgroup,'')))";
    const SEED_ZIP_URLS: [&str; 2] = [
        "https://raw.githubusercontent.com/BrunoRimbanoJunior/catalogo_ips/main/data/img-pt1.zip",
        "https://raw.githubusercontent.com/BrunoRimbanoJunior/catalogo_ips/main/data/img-pt2.zip",
    ];
    const SEED_MARKER: &str = ".images_seeded";

    fn load_env_key() -> Option<String> {
        static KEY_CACHE: OnceLock<Option<String>> = OnceLock::new();
        KEY_CACHE
            .get_or_init(|| {
                // 1) compile-time env (quando definido no build)
                for k in [option_env!("DESCRYPT_KEY"), option_env!("DECRYPT_KEY")] {
                    if let Some(val) = k {
                        if !val.trim().is_empty() {
                            return Some(val.to_string());
                        }
                    }
                }
                // 2) variavel de ambiente em runtime
                for name in ["DESCRYPT_KEY", "DECRYPT_KEY"] {
                    let direct = std::env::var(name).unwrap_or_default();
                    if !direct.trim().is_empty() {
                        return Some(direct);
                    }
                }
                // 3) tenta carregar .env em dirs comuns (cwd e pai)
                if let Ok(cwd) = std::env::current_dir() {
                    let mut dirs = Vec::new();
                    dirs.push(cwd.clone());
                    if let Some(parent) = cwd.parent() {
                        dirs.push(parent.to_path_buf());
                    }
                    dirs.dedup();
                    let env_files = [".env.production", ".env", ".env.development"];
                    for d in dirs {
                        for f in env_files {
                            let candidate = d.join(f);
                            if candidate.exists() {
                                let _ = dotenvy::from_path(&candidate);
                            }
                        }
                    }
                }
                for name in ["DESCRYPT_KEY", "DECRYPT_KEY"] {
                    let from_file = std::env::var(name).unwrap_or_default();
                    if !from_file.trim().is_empty() {
                        return Some(from_file);
                    }
                }
                None
            })
            .clone()
    }

    fn resolve_key(data_dir: &Path) -> Option<String> {
        if let Some(k) = load_env_key() {
            return Some(k);
        }
        let key_file = data_dir.join("descrypt.key");
        if key_file.exists() {
            if let Ok(txt) = std::fs::read_to_string(&key_file) {
                let t = txt.trim();
                if !t.is_empty() {
                    return Some(t.to_string());
                }
            }
        }
        None
    }

    fn guess_mime(path: &Path, bytes: &[u8]) -> &'static str {
        if bytes.len() >= 8 {
            // PNG magic
            if bytes[0..8] == [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] {
                return "image/png";
            }
        }
        if bytes.len() >= 3 {
            // JPEG magic
            if bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
                return "image/jpeg";
            }
        }
        if bytes.len() >= 12 {
            // WEBP "RIFF....WEBP"
            if &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
                return "image/webp";
            }
        }
        if bytes.len() >= 2 && bytes[0] == b'B' && bytes[1] == b'M' {
            return "image/bmp";
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .trim_start_matches('.')
            .to_ascii_lowercase();
        match ext.as_str() {
            "jpg" | "jpeg" => "image/jpeg",
            "png" => "image/png",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            _ => "application/octet-stream",
        }
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

    #[derive(Debug, Serialize, Deserialize)]
    pub struct ManifestDb {
        pub version: i64,
        pub url: String,
        pub sha256: Option<String>,
    }
    #[derive(Debug, Serialize, Deserialize)]
    pub struct ManifestImageItem {
        pub file: String,
        pub sha256: Option<String>,
    }
    #[derive(Debug, Serialize, Deserialize)]
    pub struct ManifestImages {
        pub base_url: String,
        pub files: Vec<ManifestImageItem>,
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
              FOREIGN KEY(make_id) REFERENCES makes(id)
            );
            CREATE TABLE IF NOT EXISTS products (
              id INTEGER PRIMARY KEY, brand_id INTEGER NOT NULL, code TEXT NOT NULL UNIQUE,
              description TEXT NOT NULL, application TEXT, details TEXT, oem TEXT, similar TEXT, pgroup TEXT,
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
        let _ = conn.execute("ALTER TABLE vehicles ADD COLUMN make TEXT", []);
        let _ = conn.execute("ALTER TABLE vehicles ADD COLUMN make_id INTEGER", []);
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
        let created = !db_file.exists();
        if created {
            if let Ok(res_dir) = app.path().resource_dir() {
                // Tente múltiplos caminhos possíveis dentro de resources
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
        if let Err(e) = ensure_seed_images(&data_dir, &imgs_dir) {
            eprintln!("Falha ao semear imagens: {}", e);
        }
        

        // Normaliza montadoras e coluna make em vehicles
        let _ = conn.execute("ALTER TABLE vehicles ADD COLUMN make TEXT", []);
        let _ = conn.execute("ALTER TABLE vehicles ADD COLUMN make_id INTEGER", []);
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
            .prepare("SELECT id, name FROM vehicles ORDER BY name")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(Vehicle {
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
        let mut sql = String::from("SELECT id, name FROM vehicles");
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
        let mut sql = String::from("SELECT DISTINCT v.id, v.name FROM vehicles v JOIN product_vehicles pv ON pv.vehicle_id = v.id JOIN products p ON p.id = pv.product_id");
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

    fn download_zip_file(url: &str, dest: &Path) -> Result<()> {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()?;
        let mut resp = client.get(url).send()?;
        if !resp.status().is_success() {
            return Err(anyhow::anyhow!("Falha ao baixar {}: status {}", url, resp.status()));
        }
        let mut file = File::create(dest)?;
        resp.copy_to(&mut file)?;
        Ok(())
    }

    fn extract_zip_to(zip_path: &Path, dest_dir: &Path) -> Result<()> {
        let file = File::open(zip_path)?;
        let mut archive = zip::ZipArchive::new(file)?;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i)?;
            let outpath = dest_dir.join(entry.mangled_name());
            if entry.name().ends_with('/') {
                fs::create_dir_all(&outpath)?;
            } else {
                if let Some(parent) = outpath.parent() {
                    fs::create_dir_all(parent)?;
                }
                let mut outfile = File::create(&outpath)?;
                copy(&mut entry, &mut outfile)?;
            }
        }
        Ok(())
    }

    fn ensure_seed_images(data_dir: &Path, images_dir: &Path) -> Result<()> {
        let marker = data_dir.join(SEED_MARKER);
        if marker.exists() {
            return Ok(());
        }
        // Se a pasta já tem arquivos, não sobrescreva
        if images_dir.read_dir().ok().map(|mut d| d.next().is_some()).unwrap_or(false) {
            let _ = fs::write(&marker, b"seeded");
            return Ok(());
        }
        fs::create_dir_all(images_dir)?;
        fs::create_dir_all(data_dir)?;

        for url in SEED_ZIP_URLS.iter() {
            let filename = url.split('/').last().unwrap_or("seed.zip");
            let tmp_path = data_dir.join(filename);
            download_zip_file(url, &tmp_path)?;
            extract_zip_to(&tmp_path, images_dir)?;
            let _ = fs::remove_file(&tmp_path);
        }
        let _ = fs::write(&marker, b"seeded");
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
            where_clauses.push("EXISTS (SELECT 1 FROM product_vehicles pv WHERE pv.product_id=p.id AND pv.vehicle_id = ?)".into());
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

    #[tauri::command]
    pub fn get_product_details_cmd(
        app: AppHandle,
        product_id: i64,
    ) -> Result<ProductDetails, String> {
        let conn =
            open_db(&db_path(&app).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("SELECT p.id, p.code, p.description, p.application, p.details, p.similar, b.name FROM products p JOIN brands b ON b.id = p.brand_id WHERE p.id = ?1").map_err(|e| e.to_string())?;
        let (id, code, description, application, details, similar, brand): (
            i64,
            String,
            String,
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
            similar,
            images,
        })
    }

    async fn download_to_file(client: &Client, url: &str, dest: &Path) -> Result<()> {
        let resp = client.get(url).send().await?.error_for_status()?;
        let bytes = resp.bytes().await?;
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(dest, &bytes)?;
        Ok(())
    }

    fn index_from_file_list(conn: &mut Connection, files: &[String]) -> Result<ImageIndexResult> {
        let tx = conn.transaction()?;
        let mut scanned = 0usize;
        let mut matched = 0usize;
        let mut inserted = 0usize;
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
    ) -> Result<SyncResult, String> {
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
            download_to_file(&client, &manifest.db.url, &dbf)
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
        if let Some(ref imgs) = manifest.images {
            // Abrir conexao para cache de hashes
            let conn_cache = open_db(&dbf).map_err(|e| e.to_string())?;
            for item in imgs.files.iter() {
                let local_path = imgs_dir.join(&item.file);
                let mut need = !local_path.exists();
                if !need {
                    if let Some(ref man_sha) = item.sha256 {
                        // compara com cache
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
                        // Sem hash no manifest: se o manifest mudou, forÃ§a rebaixar
                        need = true;
                    }
                }
                if need {
                    let url =
                        if item.file.starts_with("http://") || item.file.starts_with("https://") {
                            item.file.clone()
                        } else {
                            if let Ok(base) = url::Url::parse(&imgs.base_url) {
                                base.join(&item.file)
                                    .map(|u| u.to_string())
                                    .unwrap_or_else(|_| format!("{}{}", imgs.base_url, item.file))
                            } else {
                                format!("{}{}", imgs.base_url, item.file)
                            }
                        };
                    // garantir diretÃ³rio
                    if let Some(parent) = local_path.parent() {
                        if !parent.exists() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                    }
                    if let Err(e) = download_to_file(&client, &url, &local_path).await {
                        eprintln!("Falha ao baixar imagem {}: {}", item.file, e);
                    } else {
                        downloaded_images += 1;
                        if let Some(ref man_sha) = item.sha256 {
                            let _ = conn_cache.execute(
                                "INSERT OR REPLACE INTO images_cache(filename, sha256) VALUES(?1, ?2)",
                                params![&item.file, man_sha]
                            );
                        }
                    }
                }
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

    fn clear_launches_dir(imgs_dir: &std::path::Path) -> std::io::Result<()> {
        // tenta limpar variacoes do nome para evitar problemas de acentuacao/caso
        let candidates = [
            "LANÇAAMENTOS",
            "lançamentos",
            "LANCAMENTOS",
            "Lancamentos",
            "lancamentos",
        ];
        for c in candidates {
            let p = imgs_dir.join(c);
            if p.exists() && p.is_dir() {
                let _ = std::fs::remove_dir_all(&p);
            }
        }
        Ok(())
    }

    #[tauri::command]
    pub fn list_launch_images(app: AppHandle) -> Result<Vec<String>, String> {
        use std::path::PathBuf;
        use walkdir::WalkDir;
        let (_, _dbf, imgs_dir) = ensure_dirs(&app).map_err(|e| e.to_string())?;
        let candidates = [
            "LANÇAAMENTOS",
            "lançamentos",
            "LANCAMENTOS",
            "Lancamentos",
            "lancamentos",
        ];
        let mut launch_dir: Option<PathBuf> = None;
        for c in candidates {
            let p = imgs_dir.join(c);
            if p.exists() && p.is_dir() {
                launch_dir = Some(p);
                break;
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

    #[tauri::command]
    pub async fn gen_manifest_r2(
        _app: AppHandle,
        version: i64,
        db_url: String,
        out_path: String,
        r2: R2Creds,
    ) -> Result<String, String> {
        // Executa o script Node local para gerar o manifest a partir do R2
        use std::process::Command as PCommand;
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
    pub fn read_image_base64(app: AppHandle, path_or_rel: String) -> Result<String, String> {
        use std::fs;
        // monta caminho absoluto
        let (data_dir, _dbf, imgs_dir) = ensure_dirs(&app).map_err(|e| e.to_string())?;
        let abs_try = {
            let p = std::path::PathBuf::from(&path_or_rel);
            if p.is_absolute() {
                p
            } else {
                imgs_dir.join(p)
            }
        };

        let key_env = resolve_key(&data_dir);
        let try_decrypt = |data: Vec<u8>| -> Result<Vec<u8>, String> {
            let encrypted = data.len() > 5 && &data[..4] == b"CIMG";
            if !encrypted {
                return Ok(data);
            }
            if key_env.is_none() {
                eprintln!("decrypt_image: arquivo criptografado, mas DESCRYPT_KEY nao encontrado");
            }
            let key = key_env
                .as_ref()
                .ok_or_else(|| "DESCRYPT_KEY nao definido para imagem criptografada".to_string())?;
            match crate::desc::decrypt_image(&data, key) {
                Ok(p) => Ok(p),
                Err(e) => {
                    eprintln!(
                        "decrypt_image: falha ao descriptografar {} ({} bytes): {}",
                        abs_try.display(),
                        data.len(),
                        e
                    );
                    Err(format!("Falha ao descriptografar: {}", e))
                }
            }
        };

        fn to_data_url(path: &std::path::Path, bytes: Vec<u8>) -> String {
            let mime = guess_mime(path, &bytes);
            let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
            format!("data:{};base64,{}", mime, encoded)
        }

        match fs::read(&abs_try) {
            Ok(bytes) => {
                let bytes = try_decrypt(bytes).map_err(|e| e.to_string())?;
                return Ok(to_data_url(&abs_try, bytes));
            }
            Err(_) => {
                if let Some(name) = abs_try.file_name().and_then(|s| s.to_str()) {
                    for entry in WalkDir::new(&imgs_dir).into_iter().filter_map(|e| e.ok()) {
                        let p = entry.path();
                        if p.is_file() {
                            if let Some(base) = p.file_name().and_then(|s| s.to_str()) {
                                if base.eq_ignore_ascii_case(name) {
                                    if let Ok(bytes) = fs::read(p) {
                                        let bytes = try_decrypt(bytes).map_err(|e| e.to_string())?;
                                        return Ok(to_data_url(p, bytes));
                                    }
                                }
                            }
                        }
                    }
                }
                eprintln!("read_image_base64: arquivo nao encontrado {}", abs_try.display());
                return Err(format!("Falha ao ler imagem (nao encontrada): {}", abs_try.display()));
            }
        }
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

    // Tenta baixar manifest por HTTP; se falhar, usa seed do bundle (manifest.json em resources).
    async fn fetch_or_seed_manifest(
        client: &Client,
        app: &AppHandle,
        manifest_url: &str,
    ) -> Result<(CatalogManifest, String), String> {
        // Se nÃ£o for http(s), tenta ler como arquivo local
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
    pub fn import_excel(app: AppHandle, path: String) -> Result<crate::importer::ImportResult, String> {
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

        // somente caracteres alfanumÃ©ricos
        let only_alnum: String = up.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
        if !only_alnum.is_empty() {
            set.insert(only_alnum.clone());
        }

        // prefixo numÃ©rico contÃ­nuo (ex.: "7111043002LE" -> "7111043002")
        let digits_prefix: String = up.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !digits_prefix.is_empty() {
            set.insert(digits_prefix);
        }

        // retorna em ordem determinÃ­stica
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
            core::list_launch_images,
            core::import_excel,
            core::index_images,
            core::export_db_to,
            core::open_path_cmd,
            core::set_branding_image,
            core::set_header_logos,
            core::gen_manifest_r2,
            core::read_image_base64
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}







