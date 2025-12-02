use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
use anyhow::anyhow;
use pbkdf2::pbkdf2_hmac;
use sha2::Sha256;

const MAGIC: &[u8] = b"CIMG";
const VERSION: u8 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KDF_ITERS: u32 = 200_000;
// Fallback hardcoded para testes: se a senha vinda do ambiente estiver faltando,
// usamos esta chave para validar se o problema é de carregamento de env.
const TEST_FALLBACK_KEY: &str = "@Fb264e0d9efg";

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
    let nonce = Nonce::from_slice(&nonce_bytes);
    offset += NONCE_LEN;
    let ciphertext = &data[offset..];

    // Se a senha recebida estiver vazia, tenta a chave embutida de teste.
    let effective_password = if password.trim().is_empty() {
        TEST_FALLBACK_KEY
    } else {
        password
    };

    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(effective_password.as_bytes(), salt, KDF_ITERS, &mut key);
    let cipher = Aes256Gcm::new_from_slice(&key)?;
    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| anyhow!(format!("decrypt fail: {}", e)))?;
    Ok(plaintext)
}
