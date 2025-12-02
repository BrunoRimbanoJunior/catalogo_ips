use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

use crate::db::ensure_dirs;
use crate::desc::decrypt_image;

const ENV_FILES: [&str; 3] = [".env.production", ".env", ".env.development"];
const TEST_FALLBACK_KEY: &str = "@Fb264e0d9efg";

pub fn load_env_key(resource_dir: Option<&Path>, data_dir: Option<&Path>) -> Option<String> {
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
            // 3) tenta carregar .env em dirs comuns (cwd, pai, bin/resources, data_dir)
            let mut dirs: Vec<PathBuf> = Vec::new();
            if let Ok(cwd) = std::env::current_dir() {
                dirs.push(cwd.clone());
                if let Some(parent) = cwd.parent() {
                    dirs.push(parent.to_path_buf());
                }
            }
            if let Ok(exe) = std::env::current_exe() {
                if let Some(bin_dir) = exe.parent() {
                    dirs.push(bin_dir.to_path_buf());
                    dirs.push(bin_dir.join("resources"));
                    if let Some(parent) = bin_dir.parent() {
                        dirs.push(parent.to_path_buf());
                        dirs.push(parent.join("Resources"));
                    }
                }
            }
            if let Some(res) = resource_dir {
                dirs.push(res.to_path_buf());
            }
            if let Some(data) = data_dir {
                dirs.push(data.to_path_buf());
            }
            dirs.retain(|d| d.exists());
            dirs.dedup();

            for d in dirs.iter() {
                for f in ENV_FILES.iter() {
                    let candidate = d.join(f);
                    if candidate.exists() {
                        let _ = dotenvy::from_path(&candidate);
                    }
                }
            }
            for name in ["DESCRYPT_KEY", "DECRYPT_KEY"] {
                let from_file = std::env::var(name).unwrap_or_default();
                if !from_file.trim().is_empty() {
                    return Some(from_file);
                }
            }
            // 4) fallback: arquivo descrypt.key em dirs conhecidos
            for d in dirs.iter() {
                let key_file = d.join("descrypt.key");
                if key_file.exists() {
                    if let Ok(txt) = std::fs::read_to_string(&key_file) {
                        let trimmed = txt.trim();
                        if !trimmed.is_empty() {
                            return Some(trimmed.to_string());
                        }
                    }
                }
            }
            None
        })
        .clone()
}

pub fn resolve_key(app: &AppHandle, data_dir: &Path) -> Option<String> {
    let res_dir = app.path().resource_dir().ok();
    if let Some(k) = load_env_key(res_dir.as_deref(), Some(data_dir)) {
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
        if bytes[0..8] == [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] {
            return "image/png";
        }
    }
    if bytes.len() >= 3 {
        if bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
            return "image/jpeg";
        }
    }
    if bytes.len() >= 12 {
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

pub fn read_image_base64(app: &AppHandle, path_or_rel: String) -> Result<String, String> {
    // monta caminho absoluto
    let (data_dir, _dbf, imgs_dir) = ensure_dirs(app).map_err(|e| e.to_string())?;
    let abs_try = {
        let p = std::path::PathBuf::from(&path_or_rel);
        if p.is_absolute() {
            p
        } else {
            imgs_dir.join(p)
        }
    };
    let _name_norm = abs_try
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.trim_end_matches(".cimg"))
        .map(|s| s.to_ascii_lowercase());

    let key_env = resolve_key(app, &data_dir);
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
            .map(|s| s.as_str())
            .unwrap_or(TEST_FALLBACK_KEY);
        match decrypt_image(&data, key) {
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

    let read_with_fallback = |path: &std::path::Path| -> Option<Vec<u8>> {
        if let Ok(bytes) = fs::read(path) {
            return Some(bytes);
        }
        // tenta <orig>.cimg quando o arquivo nao existir
        if let Some(as_str) = path.to_str() {
            let as_owned = as_str.to_string();
            if !as_owned.to_ascii_lowercase().ends_with(".cimg") {
                let alt = PathBuf::from(format!("{}.cimg", as_owned));
                if let Ok(bytes) = fs::read(&alt) {
                    return Some(bytes);
                }
            }
        }
        None
    };

    if let Some(bytes) = read_with_fallback(&abs_try) {
        let bytes = try_decrypt(bytes).map_err(|e| e.to_string())?;
        return Ok(to_data_url(&abs_try, bytes));
    }

    eprintln!("read_image_base64: arquivo nao encontrado {}", abs_try.display());
    Err(format!(
        "Falha ao ler imagem (nao encontrada): {}",
        abs_try.display()
    ))
}
