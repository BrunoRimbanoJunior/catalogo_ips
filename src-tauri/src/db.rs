use anyhow::Result;
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};

pub const DB_FILE_NAME: &str = "catalog.db";
pub const IMAGES_DIR_NAME: &str = "images";
pub const META_DB_VERSION_KEY: &str = "db_version";
pub const META_MANIFEST_HASH_KEY: &str = "manifest_hash";

pub fn app_data_dir(app: &AppHandle) -> Result<PathBuf> {
  Ok(app.path().app_local_data_dir()?)
}

pub fn db_path(app: &AppHandle) -> Result<PathBuf> {
  Ok(app_data_dir(app)?.join(DB_FILE_NAME))
}

pub fn ensure_dirs(app: &AppHandle) -> Result<(PathBuf, PathBuf, PathBuf)> {
  let data = app_data_dir(app)?;
  if !data.exists() {
    fs::create_dir_all(&data)?;
  }
  let db = data.join(DB_FILE_NAME);
  let imgs = data.join(IMAGES_DIR_NAME);
  if !imgs.exists() {
    fs::create_dir_all(&imgs)?;
  }
  Ok((data, db, imgs))
}

pub fn open_db(path: &Path) -> Result<Connection> {
  let conn = Connection::open(path)?;
  conn.busy_timeout(Duration::from_secs(30))?;
  Ok(conn)
}
