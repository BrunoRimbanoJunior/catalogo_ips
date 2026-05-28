use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
use anyhow::anyhow;
use pbkdf2::pbkdf2_hmac;
use sha2::Sha256;

const MAGIC: &[u8] = b"CIMG";
const VERSION: u8 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KDF_ITERS: u32 = 200_000;

pub fn decrypt_image(data: &[u8], password: &str) -> anyhow::Result<Vec<u8>> {
    if data.len() < MAGIC.len() + 1 + SALT_LEN + NONCE_LEN {
        anyhow::bail!("arquivo curto");
    }
    if &data[..MAGIC.len()] != MAGIC || data[MAGIC.len()] != VERSION {
        anyhow::bail!("formato desconhecido");
    }
    let mut offset = MAGIC.len() + 1;
    let salt = &data[offset..offset + SALT_LEN];
    offset += SALT_LEN;
    let nonce_bytes: [u8; NONCE_LEN] = data[offset..offset + NONCE_LEN].try_into()?;
    #[allow(deprecated)]
    // aes-gcm reexporta generic-array 0.x; suppress ate atualizarmos dependencia
    let nonce = Nonce::from_slice(&nonce_bytes);
    offset += NONCE_LEN;
    let ciphertext = &data[offset..];

    if password.trim().is_empty() {
        anyhow::bail!("senha de descriptografia ausente");
    }

    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, KDF_ITERS, &mut key);
    let cipher = Aes256Gcm::new_from_slice(&key)?;
    let plaintext = cipher
        // aes-gcm decrypt espera um Nonce por referÇõncia; from_slice jÇÁ retorna &Nonce
        .decrypt(nonce, ciphertext)
        .map_err(|e| anyhow!(format!("decrypt fail: {}", e)))?;
    Ok(plaintext)
}
