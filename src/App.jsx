import { useEffect, useMemo, useState } from "react";
import {
  initApp,
  fetchBrands,
  fetchVehicles,
  fetchGroups,
  fetchVehiclesFiltered,
  searchProducts,
  getProductDetails,
  syncFromManifest,
  importExcel,
  indexImagesFromManifest,
  setBrandingImage,
  exportDbTo,
  genManifestR2,
  listLaunchImages,
  readImageBase64,
} from "./lib/api";
import { supabase, supabaseService, supabaseServiceKey, supabaseRestUrl } from "./lib/supabaseClient";
import { open, save } from "@tauri-apps/plugin-dialog";
import "./App.css";

function resolveDefaultManifest(isDev) {
  const saved = localStorage.getItem("manifestUrl") || "";
  const envUrl = import.meta.env.VITE_DEFAULT_MANIFEST_URL || "";
  const devLocal = `${window.location.origin}/manifest.json`;
  const fallbackGit = "https://raw.githubusercontent.com/BrunoRimbanoJunior/catalogo_ips/main/manifest.json";
  if (isDev) return saved || envUrl || devLocal;
  return saved || envUrl || fallbackGit;
}

async function openExternalIfAvailable(path) {
  try {
    const mod = await import("@tauri-apps/plugin-opener");
    if (mod) {
      if (typeof mod.openPath === "function") {
        await mod.openPath(path);
        return true;
      }
      // Compatibilidade com versões antigas do plugin
      if (typeof mod.open === "function") {
        await mod.open(path);
        return true;
      }
    }
  } catch (err) {
    console.warn("Falha ao abrir caminho externo:", err);
  }
  return false;
}

function normalizeSocialLink(value, kind) {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (kind === "email" && !trimmed.toLowerCase().startsWith("mailto:")) {
    return `mailto:${trimmed}`;
  }
  return trimmed;
}

const SOCIAL_ICONS = {
  instagram: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 2h10a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5zm0 2a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3V7a3 3 0 0 0-3-3zm5 3.5A4.5 4.5 0 1 1 7.5 12 4.5 4.5 0 0 1 12 7.5zm0 2A2.5 2.5 0 1 0 14.5 12 2.5 2.5 0 0 0 12 9.5zm5-3a1 1 0 1 1-1 1 1 1 0 0 1 1-1z" />
    </svg>
  ),
  youtube: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M22 8.4v7.2c0 1.5-1 2.9-2.4 3.2A69 69 0 0 1 12 19a69 69 0 0 1-7.6-.2C3 18.7 2 17.3 2 15.6V8.4C2 6.7 3 5.3 4.4 5a69 69 0 0 1 7.6-.2 69 69 0 0 1 7.6.2C21 5.3 22 6.7 22 8.4zM10 9v4.8l4.5-2.4z" />
    </svg>
  ),
  email: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm0 2v.2l8 4.6 8-4.6V7zm16 10V9.6l-7.4 4.3a1 1 0 0 1-1.2 0L4 9.6V17z" />
    </svg>
  ),
};

const EMPTY_REGISTRATION = {
  person_type: "pf",
  country: "Brasil",
  state: "",
  city: "",
  cpf_cnpj: "",
  full_name: "",
  phone_area: "",
  phone_number: "",
  email: "",
};

function App() {
  const isDev = import.meta.env.MODE !== "production";
  const deviceFingerprint = useMemo(() => {
    const stored = localStorage.getItem("device.fingerprint");
    if (stored) return stored;
    const fresh = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `dev-${Date.now()}-${Math.random()}`;
    localStorage.setItem("device.fingerprint", fresh);
    return fresh;
  }, []);

  const [profile, setProfile] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authEmail, setAuthEmail] = useState(localStorage.getItem("registration.email") || "");
  const [authMessage, setAuthMessage] = useState("");
  const [authError, setAuthError] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [registration, setRegistration] = useState(EMPTY_REGISTRATION);
  const [adminError, setAdminError] = useState("");
  const [pendingProfiles, setPendingProfiles] = useState([]);
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const cachedProfile = (() => {
    try {
      const raw = localStorage.getItem("profile.cached");
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  })();

  function cacheProfileIfApproved(p) {
    try {
      if (p && p.status === "approved") {
        localStorage.setItem("profile.cached", JSON.stringify(p));
      }
    } catch {}
  }

  // Estado básico
  const [ready, setReady] = useState(true);
  const [imagesDir, setImagesDir] = useState("");
  const [dataDir, setDataDir] = useState("");
  const [dbPath, setDbPath] = useState("");
  const [dbVersion, setDbVersion] = useState(0);

  // Listas e filtros
  const [brands, setBrands] = useState([]);
  const [groups, setGroups] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [brandId, setBrandId] = useState("");
  const [group, setGroup] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [codeQuery, setCodeQuery] = useState("");
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(null);
  const [imageUrls, setImageUrls] = useState([]);
  const [preview, setPreview] = useState({ open: false, index: 0 });

  // Branding + mensagens
  const [brandingLogoUrl, setBrandingLogoUrl] = useState("");
  const [brandingBgUrl, setBrandingBgUrl] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const [importMsg, setImportMsg] = useState("");
  const [updateInfo, setUpdateInfo] = useState(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [runtimeVersion, setRuntimeVersion] = useState(import.meta.env.VITE_APP_VERSION || "0.0.0");
  const [launchImages, setLaunchImages] = useState([]);
  const [launchModal, setLaunchModal] = useState({ open: false, index: 0, loading: false, error: "" });

  const instagramUrl = normalizeSocialLink(import.meta.env.VITE_SOCIAL_INSTAGRAM || "", "link");
  const youtubeUrl = normalizeSocialLink(import.meta.env.VITE_SOCIAL_YOUTUBE || "", "link");
  const emailUrl = normalizeSocialLink(import.meta.env.VITE_SOCIAL_EMAIL || "", "email");
  const socialLinks = useMemo(() => {
    return [
      { key: "instagram", label: "Instagram", url: instagramUrl },
      { key: "youtube", label: "YouTube", url: youtubeUrl },
      { key: "email", label: "E-mail", url: emailUrl },
    ].filter((link) => !!link.url);
  }, [instagramUrl, youtubeUrl, emailUrl]);

  const selectedBrand = useMemo(
    () => brands.find((b) => String(b.id) === String(brandId)) || null,
    [brands, brandId]
  );

  const normalizedBrandId = useMemo(() => {
    if (brandId === null || brandId === undefined || brandId === "") return null;
    const n = Number(brandId);
    return Number.isNaN(n) ? null : n;
  }, [brandId]);

  const currentAppVersion = runtimeVersion || "0.0.0";

  const supabaseConfigured = Boolean(supabase && import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY);
  const isAdminDev = Boolean(supabaseServiceKey && supabaseServiceKey.length > 0);

  function compareVersions(a, b) {
    const pa = (a || "").split(".").map((n) => parseInt(n, 10) || 0);
    const pb = (b || "").split(".").map((n) => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const va = pa[i] || 0;
      const vb = pb[i] || 0;
      if (va > vb) return 1;
      if (va < vb) return -1;
    }
    return 0;
  }

  useEffect(() => {
    if (!supabaseConfigured) {
      setAuthLoading(false);
      setAuthError("Supabase não configurado. Preencha VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY.");
      return;
    }
    (async () => {
      setAuthLoading(true);
      try {
        const { data, error } = await supabase
          .from("profiles")
          .select("id,status,person_type,country,state,city,cpf_cnpj,full_name,phone_area,phone_number,email,device_fingerprint")
          .or(`device_fingerprint.eq.${deviceFingerprint}${authEmail ? `,email.eq.${authEmail}` : ""}`)
          .maybeSingle();
        if (error && error.code !== "PGRST116") throw error;
        if (data) {
          setProfile(data);
          setRegistration((prev) => ({
            ...prev,
            person_type: data.person_type || prev.person_type,
            country: data.country || prev.country,
            state: data.state || prev.state,
            city: data.city || prev.city,
            cpf_cnpj: data.cpf_cnpj || prev.cpf_cnpj,
            full_name: data.full_name || prev.full_name,
            phone_area: data.phone_area || prev.phone_area,
            phone_number: data.phone_number || prev.phone_number,
            email: data.email || prev.email || authEmail,
          }));
        }
        setAuthError("");
      } catch (err) {
        setAuthError(`Falha ao carregar cadastro: ${err.message || err}`);
      } finally {
        setAuthLoading(false);
      }
    })();
  }, [supabaseConfigured, deviceFingerprint, authEmail]);

  async function loadPendingProfiles() {
    if (!isAdminDev || !supabaseRestUrl || !supabaseServiceKey) return;
    try {
      const res = await fetch(
        `${supabaseRestUrl}/rest/v1/profiles?select=*&status=eq.pending&order=created_at.asc`,
        {
          headers: {
            apikey: supabaseServiceKey,
            Authorization: `Bearer ${supabaseServiceKey}`,
          },
        }
      );
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setPendingProfiles(data || []);
      setAdminError("");
    } catch (err) {
      setAdminError(`Falha ao carregar pendentes: ${err.message || err}`);
      console.error("Erro ao carregar pendentes", err);
    }
  }

  useEffect(() => {
    loadPendingProfiles();
  }, [isAdminDev]);

  async function loadLaunches(autoOpen = false) {
    setLaunchModal((m) => ({ ...m, loading: true, error: "" }));
    try {
      const files = await listLaunchImages();
      if (!files || files.length === 0) {
        setLaunchImages([]);
        setLaunchModal((m) => ({ ...m, loading: false, error: "Nenhuma imagem de lançamento encontrada." }));
        return;
      }
      const outs = [];
      for (const f of files) {
        try {
          const dataUrl = await readImageBase64(f);
          outs.push(dataUrl);
        } catch {}
      }
      setLaunchImages(outs);
      if (outs.length > 0) {
        setLaunchModal({ open: true, index: 0, loading: false, error: "" });
      } else {
        setLaunchModal((m) => ({ ...m, loading: false, error: "Nenhuma imagem de lançamento encontrada." }));
      }
    } catch (e) {
      const msg = `Falha ao carregar lançamentos: ${e.message || e}`;
      setLaunchModal((m) => ({ ...m, loading: false, error: msg }));
    }
  }

  function shiftLaunch(delta) {
    setLaunchModal((m) => {
      if (!launchImages.length) return m;
      const next = (m.index + delta + launchImages.length) % launchImages.length;
      return { ...m, index: next };
    });
  }

  useEffect(() => {
    loadLaunches(true);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        const v = await getVersion();
        if (v) setRuntimeVersion(v);
      } catch {
        // Web build: fica com VITE_APP_VERSION
      }
    })();
  }, []);

  useEffect(() => {
    if (authEmail) localStorage.setItem("registration.email", authEmail);
  }, [authEmail]);

  async function handleSendMagicLink(e) {
    e?.preventDefault();
    setAuthError("");
    setAuthMessage("");
    setAuthMessage("Este fluxo usa aprovação manual. Apenas preencha a ficha e aguarde liberação.");
  }

  async function submitRegistration(e) {
    e?.preventDefault();
    setAuthError("");
    setAuthMessage("");
    setSavingProfile(true);
    try {
      let existingId = profile?.id || null;
      if (!existingId && (registration.email || authEmail)) {
        const { data: existing, error: exErr } = await supabase
          .from("profiles")
          .select("id")
          .eq("email", registration.email || authEmail)
          .maybeSingle();
        if (!exErr && existing?.id) existingId = existing.id;
      }

      const payload = {
        ...registration,
        email: registration.email || authEmail || "",
        status: "pending",
        device_fingerprint: profile?.device_fingerprint || deviceFingerprint,
        id: existingId || undefined,
      };

      if (supabase) {
        const { data, error } = await supabase
          .from("profiles")
          .upsert(payload, { onConflict: "email" })
          .select()
          .maybeSingle();
        if (error) throw error;
        setProfile(data);
        setAuthMessage("Cadastro enviado. Aguarde aprovação do time.");
        setSubmitted(true);
        await loadPendingProfiles();
      } else {
        throw new Error("Supabase não configurado.");
      }
    } catch (err) {
      setAuthError(`Falha ao salvar cadastro: ${err.message || err}`);
    } finally {
      setSavingProfile(false);
    }
  }

  async function approveProfile(id) {
    if (!isAdminDev || !supabaseRestUrl || !supabaseServiceKey) {
      setAdminError("Service role não configurado (apenas dev).");
      return;
    }
    try {
      const res = await fetch(
        `${supabaseRestUrl}/rest/v1/profiles?id=eq.${id}`,
        {
          method: "PATCH",
          headers: {
            apikey: supabaseServiceKey,
            Authorization: `Bearer ${supabaseServiceKey}`,
            "Content-Type": "application/json",
            Prefer: "return=representation",
          },
          body: JSON.stringify({ status: "approved" }),
        }
      );
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || `HTTP ${res.status}`);
      }
      setPendingProfiles((prev) => prev.filter((p) => p.id !== id));
      if (profile && profile.id === id) {
        setProfile({ ...profile, status: "approved" });
        setSubmitted(false);
      }
      await loadPendingProfiles();
    } catch (err) {
      setAdminError(`Falha ao aprovar: ${err.message || err}`);
    }
  }

  // Credenciais R2 (para gerar manifest localmente no Dev)
  const [r2AccountId, setR2AccountId] = useState(localStorage.getItem("r2.account_id") || "");
  const [r2Bucket, setR2Bucket] = useState(localStorage.getItem("r2.bucket") || "");
  const [r2AccessKeyId, setR2AccessKeyId] = useState(localStorage.getItem("r2.access_key_id") || "");
  const [r2SecretAccessKey, setR2SecretAccessKey] = useState(localStorage.getItem("r2.secret_access_key") || "");
  const [r2Endpoint, setR2Endpoint] = useState(localStorage.getItem("r2.endpoint") || "");
  const [r2PublicBaseUrl, setR2PublicBaseUrl] = useState(localStorage.getItem("r2.public_base_url") || "");
  const [manifestDbUrl, setManifestDbUrl] = useState(
    localStorage.getItem("manifest.db_url") ||
      "https://raw.githubusercontent.com/BrunoRimbanoJunior/catalogo_ips/main/data/catalog.db"
  );

  // Inicialização do app + auto-sync/index
  useEffect(() => {
    (async () => {
      const info = await initApp();
      setImagesDir(info.images_dir);
      setDataDir(info.data_dir);
      setDbPath(info.db_path);
      setDbVersion(info.db_version);

      const [bs, vs] = await Promise.all([fetchBrands(), fetchVehicles()]);
      setBrands(bs);
      setVehicles(vs);

      // Libera a UI imediatamente
      setReady(true);

      // Executa sync + index em background (sem bloquear a renderização)
      const manifestToUse = resolveDefaultManifest(isDev);
      if (manifestToUse) {
        (async () => {
          try {
            try {
              const manifestJson = await fetch(manifestToUse).then((r) => (r.ok ? r.json() : null));
              if (manifestJson?.appVersion && compareVersions(manifestJson.appVersion, currentAppVersion) > 0) {
                setUpdateInfo({
                  availableVersion: manifestJson.appVersion,
                  downloadUrl: manifestJson.appDownloadUrl || manifestToUse,
                });
              }
            } catch {}

            const res = await syncFromManifest(manifestToUse);
            setDbVersion(res.db_version);
            setSyncMsg(`Atualizado ao iniciar: db v${res.db_version} | imgs +${res.downloaded_images}`);
            localStorage.setItem("manifestUrl", manifestToUse);
            // Recarrega listas após atualizar o DB
            try {
              const [nBrands, nVehicles] = await Promise.all([fetchBrands(), fetchVehicles()]);
              setBrands(nBrands);
              setVehicles(nVehicles);
              const gs = await fetchGroups(
                normalizedBrandId,
                selectedBrand ? selectedBrand.name : null
              );
              setGroups(gs);
              const vs2 = await fetchVehiclesFiltered(
                normalizedBrandId,
                group || null
              );
              setVehicles(vs2);
            } catch {}
          } catch (e) {
            setSyncMsg(`Falha sync inicial: ${e}`);
          }
          try {
            const r = await indexImagesFromManifest(manifestToUse);
            setImportMsg(`Index inicial: varridos ${r.scanned} | correspondidos ${r.matched} | inseridos ${r.inserted}`);
          } catch (e) {
            setImportMsg(`Falha index inicial: ${e}`);
          }
          try { await doSearch(); } catch {}
        })();
      }
    })();
  }, []);

  

  // Carregar branding versionado do projeto (public/images/branding.json)
  useEffect(() => {
    fetch("/images/branding.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (!cfg) return;
        if (cfg.logo) setBrandingLogoUrl(`/images/${cfg.logo}`);
        if (cfg.background) setBrandingBgUrl(`/images/${cfg.background}`);
      })
      .catch(() => {});
  }, []);

  // Atualizar grupos e vei­culos conforme marca/grupo
  useEffect(() => {
    (async () => {
      const gs = await fetchGroups(
        normalizedBrandId,
        selectedBrand ? selectedBrand.name : null
      );
      setGroups(gs);
      const vs = await fetchVehiclesFiltered(normalizedBrandId, group || null);
      setVehicles(vs);
    })();
  }, [brandId, group]);

  // Debounce de busca
  useEffect(() => {
    const t = setTimeout(() => { doSearch(); }, 300);
    return () => clearTimeout(t);
  }, [brandId, group, vehicleId, codeQuery]);

  // Limpa seleção ao alterar filtros ou busca
  useEffect(() => {
    setSelected(null);
    setImageUrls([]);
    setPreview({ open: false, index: 0 });
  }, [brandId, group, vehicleId, codeQuery]);

  // Auto-ocultar mensagens da barra de status
  useEffect(() => {
    if (syncing) return; // não fecha enquanto estiver rodando
    if (!syncMsg && !importMsg) return;
    const h = setTimeout(() => { setSyncMsg(""); setImportMsg(""); }, 6000);
    return () => clearTimeout(h);
  }, [syncMsg, importMsg, syncing]);

  async function doSearch() {
    const hasFilters =
      (normalizedBrandId !== null && normalizedBrandId !== undefined) ||
      (group && group.trim() !== "") ||
      (vehicleId && String(vehicleId).trim() !== "") ||
      (codeQuery && codeQuery.trim() !== "");
    if (!hasFilters) {
      setResults([]);
      return;
    }
    const params = {
      brand_id: normalizedBrandId,
      group: group || null,
      vehicle_id: vehicleId ? Number(vehicleId) : null,
      code_query: codeQuery || null,
      limit: 200,
    };
    const list = await searchProducts(params);
    setResults(list);
  }

  async function openDetails(id) {
    const d = await getProductDetails(id);
    setSelected(d);
  }

  function normalizeFsPath(p) {
    return (p || "").replace(/\\/g, "/");
  }
  function joinFsPath(dir, file) {
    // Se o arquivo jÃ¡ Ã© absoluto (Windows C:\ ou Unix /), retorna normalizado
    if (/^[a-zA-Z]:\\/.test(file) || file.startsWith("/")) {
      return normalizeFsPath(file);
    }
    const sep = dir.endsWith("/") || dir.endsWith("\\") ? "" : "/";
    return normalizeFsPath(`${dir}${sep}${file}`);
  }

  // Carrega imagens como data URL (garante render mesmo no dev)
  useEffect(() => {
    (async () => {
      if (!selected) { setImageUrls([]); return; }
      const seen = new Set();
      const files = (selected.images || []).filter((raw) => {
        const key = normalizeFsPath(raw).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      try {
        const { readImageBase64 } = await import("./lib/api.js");
        const outs = [];
        for (const f of files) {
          const p = joinFsPath(imagesDir, f);
          try { outs.push(await readImageBase64(p)); }
          catch { outs.push(""); }
        }
        const uniq = []; const seenData = new Set(); for (const img of outs) { if (!img) continue; if (seenData.has(img)) continue; seenData.add(img); uniq.push(img); } setImageUrls(uniq);
      } catch {
        // fallback para asset:// caso invoke nÃ£o esteja disponÃ­vel
        const outs = files.map((f) => {
          const norm = normalizeFsPath(joinFsPath(imagesDir, f));
          const trimmed = norm.startsWith("/") ? norm.slice(1) : norm;
          return `asset://localhost/${trimmed}`;
        });
        const uniq2 = []; const seenData2 = new Set(); for (const img of outs) { if (seenData2.has(img)) continue; seenData2.add(img); uniq2.push(img); } setImageUrls(uniq2);
      }
    })();
  }, [selected, imagesDir]);

  // Atalhos de teclado para fechar/navegar preview
  useEffect(() => {
    function onKey(e) {
      if (!preview.open) return;
      if (e.key === "Escape") setPreview({ open: false, index: 0 });
      if (e.key === "ArrowRight") setPreview(p => ({ open: true, index: (p.index + 1) % imageUrls.length }));
      if (e.key === "ArrowLeft") setPreview(p => ({ open: true, index: (p.index + imageUrls.length - 1) % imageUrls.length }));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview.open, imageUrls.length]);

  // Sincronizar usando manifest padrÃ£o (sempre)
  async function runSyncDefault() {
    const m = resolveDefaultManifest(isDev);
    if (!m) return;
    setSyncing(true);
    try {
      const res = await syncFromManifest(m);
      setSyncMsg(`Banco atualizado: ${res.updated_db ? "sim" : "nÃ£o"} | Imagens baixadas: ${res.downloaded_images} | versÃ£o: ${res.db_version}`);
      setDbVersion(res.db_version);
      localStorage.setItem("manifestUrl", m);
      try {
        const r = await indexImagesFromManifest(m);
        setImportMsg(`Index manifest: varridos ${r.scanned} | correspondidos ${r.matched} | inseridos ${r.inserted}`);
      } catch (e) {
        setImportMsg(`Falha ao indexar manifest: ${e}`);
      }
      // Recarrega listas com o DB atualizado
      try {
        const [nBrands, nVehicles] = await Promise.all([fetchBrands(), fetchVehicles()]);
        setBrands(nBrands);
        setVehicles(nVehicles);
        const gs = await fetchGroups(
          normalizedBrandId,
          selectedBrand ? selectedBrand.name : null
        );
        setGroups(gs);
        const vs2 = await fetchVehiclesFiltered(normalizedBrandId, group || null);
        setVehicles(vs2);
      } catch {}
      await doSearch();
    } catch (e) {
      setSyncMsg(`Falha ao sincronizar: ${e}`);
    } finally {
      setSyncing(false);
    }
  }

  // Importar Excel
  async function runImportExcel() {
    const selected = await open({ multiple: false, filters: [{ name: "Excel", extensions: ["xlsx", "xls"] }] });
    if (!selected || Array.isArray(selected)) return;
    setImportMsg(`Importando: ${selected}`);
    try {
      const res = await importExcel(selected);
      setImportMsg(`Linhas: ${res.processed_rows} | Produtos upsert: ${res.upserted_products} | vÃ­nculos veÃ­culo: ${res.linked_vehicles} | nova versÃ£o: ${res.new_db_version}`);
      setDbVersion(res.new_db_version);
      const [bs, gs, vs] = await Promise.all([
        fetchBrands(),
        fetchGroups(
          normalizedBrandId,
          selectedBrand ? selectedBrand.name : null
        ),
        fetchVehiclesFiltered(normalizedBrandId, group || null),
      ]);
      setBrands(bs); setGroups(gs); setVehicles(vs);
      await doSearch();
    } catch (e) {
      setImportMsg(`Falha ao importar: ${e}`);
    }
  }

  // Exportar DB
  async function runExportDb() {
    const dest = await save({ title: "Salvar banco de dados", defaultPath: "catalog.db", filters: [{ name: "SQLite", extensions: ["db"] }] });
    if (!dest) return;
    try {
      const r = await exportDbTo(dest);
      setImportMsg(`DB exportado: ${r.output}`);
    } catch (e) {
      setImportMsg(`Falha ao exportar DB: ${e}`);
    }
  }

  // Exportar DB + Manifest (R2)
  async function runExportDbAndManifest() {
    const dest = await save({ title: "Salvar banco de dados", defaultPath: "catalog.db", filters: [{ name: "SQLite", extensions: ["db"] }] });
    if (!dest) return;
    try {
      const r = await exportDbTo(dest);
      const manifestOut = await save({ title: "Salvar manifest.json", defaultPath: "manifest.json", filters: [{ name: "JSON", extensions: ["json"] }] });
      if (!manifestOut) { setImportMsg(`DB exportado: ${r.output} | Manifest cancelado.`); return; }
      const version = Math.floor(Date.now() / 1000);
      const outPath = await genManifestR2({
        version,
        dbUrl: manifestDbUrl,
        outPath: manifestOut,
        r2: {
          account_id: r2AccountId,
          bucket: r2Bucket,
          access_key_id: r2AccessKeyId,
          secret_access_key: r2SecretAccessKey,
          endpoint: r2Endpoint || null,
          public_base_url: r2PublicBaseUrl || null,
        },
      });
      setImportMsg(`DB exportado: ${r.output} | Manifest gerado: ${outPath}`);
    } catch (e) {
      setImportMsg(`Falha ao exportar/manifest: ${e}`);
    }
  }

  // Abrir pastas/arquivo
  async function openDataDirFolder() { if (dataDir) await openExternalIfAvailable(dataDir); }
  async function openImagesFolder() { if (imagesDir) await openExternalIfAvailable(imagesDir); }
  async function openDbFilePath() { if (dbPath) await openExternalIfAvailable(dbPath); }

  const isApproved = profile?.status === "approved";
  const blockAccess = !supabaseConfigured || (!isApproved && !submitted);
  const profileStatusLabel = profile?.status || "pending";

  if (!ready) {
    return (
      <main className="container" style={brandingBgUrl ? { backgroundImage: `url(${brandingBgUrl})`, backgroundSize: "cover", backgroundAttachment: "fixed", backgroundPosition: "center" } : undefined}>
        Carregandoâ€¦
      </main>
    );
  }

  return (
    <>
    <main className={`container ${blockAccess ? "app-blocked" : ""}`} style={brandingBgUrl ? { backgroundImage: `url(${brandingBgUrl})`, backgroundSize: "cover", backgroundAttachment: "fixed", backgroundPosition: "center" } : undefined}>
      <div className="appbar">
        <div>{brandingLogoUrl ? <img className="logo" src={brandingLogoUrl} alt="logo" onError={(e)=>{ e.currentTarget.style.display = "none"; }} /> : null}</div>
        <h1>Catálogo IPS</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {updateInfo && !updateDismissed && (
            <div className="update-banner">
              <span>Nova versão disponível: {updateInfo.availableVersion} (atual {currentAppVersion})</span>
              {updateInfo.downloadUrl ? (
                <button
                  onClick={async () => {
                    try {
                      const mod = await import("@tauri-apps/plugin-opener");
                      if (mod?.openPath) {
                        await mod.openPath(updateInfo.downloadUrl);
                      } else if (mod?.open) {
                        await mod.open(updateInfo.downloadUrl);
                      } else {
                        window.open(updateInfo.downloadUrl, "_blank");
                      }
                    } catch {
                      window.open(updateInfo.downloadUrl, "_blank");
                    }
                  }}
                >
                  Baixar/Atualizar
                </button>
              ) : null}
              <button className="ghost" onClick={() => setUpdateDismissed(true)}>Fechar</button>
            </div>
          )}
          <div className="social-block">
            {socialLinks.length > 0 && (
              <nav className="social-links">
                {socialLinks.map((link) => (
                  <a key={link.key} href={link.url} target="_blank" rel="noreferrer" aria-label={link.label}>
                    {SOCIAL_ICONS[link.key]}
                  </a>
                ))}
              </nav>
            )}
            <button className="launch-button" onClick={() => loadLaunches(false)} disabled={launchModal.loading}>
              {launchModal.loading ? "Carregando..." : "Lançamentos"}
            </button>
            {launchModal.error ? <span className="launch-error">{launchModal.error}</span> : null}
          </div>
          {(syncMsg || importMsg) && !isDev ? (
            <span style={{ fontSize: 12, opacity: 0.85 }}>{syncMsg}{importMsg ? (syncMsg ? " | " : "") + importMsg : ""}</span>
          ) : null}
          {isDev && (
            <div className="tools">
              <details>
                <summary>Ferramentas</summary>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
                  <button disabled={syncing} onClick={runSyncDefault}>{syncing ? "Sincronizandoâ€¦" : "Verificar atualizações (manifest padrão)"}</button>
                  <button onClick={async()=>{ const m = resolveDefaultManifest(isDev); if(!m) return; setImportMsg("Indexando via manifestâ€¦"); try { const r = await indexImagesFromManifest(m); setImportMsg(`Index manifest: varridos ${r.scanned} | correspondidos ${r.matched} | inseridos ${r.inserted}`); } catch(e){ setImportMsg(`Falha ao indexar manifest: ${e}`);} }}>Indexar via manifest (padrão)</button>
                  <button onClick={runImportExcel}>Importar Excel</button>
                  <button onClick={runExportDb}>Exportar DB</button>
                  <button onClick={runExportDbAndManifest}>Exportar DB + Manifest (R2)</button>
                  <button onClick={()=>{ localStorage.removeItem("manifestUrl"); setImportMsg("Manifest salvo limpo. Usando padrão."); }}>Limpar manifest salvo</button>
                  {/* Abrir pastas/arquivo */}
                  <button onClick={openDataDirFolder}>Abrir dados</button>
                  <button onClick={openImagesFolder}>Abrir imagens</button>
                  <button onClick={openDbFilePath}>Abrir DB</button>
                  <button onClick={async ()=>{ const s = await fetchGroupsStats(); setImportMsg(`Grupos: ${s.distinct_groups} | Produtos c/ grupo: ${s.products_with_group}`); }}>Diagnóstico de grupos</button>
                  <div style={{ gridColumn: "1 / -1", marginTop: 8 }}>
                    <details>
                      <summary>Credenciais R2 / Config Manifest</summary>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
                        <input placeholder="R2 Account ID" title="ID da conta R2 (Account ID)" value={r2AccountId} onChange={(e)=>setR2AccountId(e.target.value)} />
                        <input placeholder="R2 Bucket" title="Nome exato do bucket (ex.: ipsimages)" value={r2Bucket} onChange={(e)=>setR2Bucket(e.target.value)} />
                        <input placeholder="R2 Access Key ID" title="Chave de acesso S3 do R2 (Access Key ID)" value={r2AccessKeyId} onChange={(e)=>setR2AccessKeyId(e.target.value)} />
                        <input placeholder="R2 Secret Access Key" title="Segredo da chave S3 do R2 (Secret Access Key)" value={r2SecretAccessKey} onChange={(e)=>setR2SecretAccessKey(e.target.value)} />
                        <input placeholder="R2 Endpoint (opcional)" title="Endpoint S3 opcional (deixe vazio para usar padrÃ£o)" value={r2Endpoint} onChange={(e)=>setR2Endpoint(e.target.value)} />
                        <input placeholder="R2 Public Base URL" title="URL pÃºblica do bucket (https://pub-â€¦r2.dev/)" value={r2PublicBaseUrl} onChange={(e)=>setR2PublicBaseUrl(e.target.value)} />
                        <input placeholder="DB URL (raw Git)" title="URL raw do catalog.db no GitHub" value={manifestDbUrl} onChange={(e)=>setManifestDbUrl(e.target.value)} />
                        <button onClick={()=>{ localStorage.setItem("r2.account_id", r2AccountId); localStorage.setItem("r2.bucket", r2Bucket); localStorage.setItem("r2.access_key_id", r2AccessKeyId); localStorage.setItem("r2.secret_access_key", r2SecretAccessKey); localStorage.setItem("r2.endpoint", r2Endpoint); localStorage.setItem("r2.public_base_url", r2PublicBaseUrl); localStorage.setItem("manifest.db_url", manifestDbUrl); setImportMsg("Credenciais salvas."); }}>Salvar credenciais</button>
                      </div>
                    </details>
                  </div>
                </div>
                {(syncMsg || importMsg) && <p style={{ marginTop: 6 }}>{syncMsg} {importMsg && (syncMsg ? " | " : null)} {importMsg}</p>}
              </details>
            </div>
          )}
        </div>
      </div>

      {(syncMsg || importMsg || syncing) ? (
        <div className="statusbar">
          <div className="small">{syncing ? "Sincronizando... " : ""}{syncMsg}{importMsg ? (syncMsg ? " | " : "") + importMsg : ""}</div>
          <button style={{ marginLeft: 8, marginTop: 6, padding: "2px 6px", borderRadius: 6, border: 0, cursor: "pointer" }} onClick={() => { setSyncMsg(""); setImportMsg(""); }}>X</button>
        </div>
      ) : null}

      <div className="layout">
        <aside className="sidebar">
          <h3>Fabricantes</h3>
          <div className="chips">
            <div className={`chip ${!brandId ? "active" : ""}`} onClick={() => { setBrandId(""); setGroup(""); setVehicleId(""); }}>Todos</div>
            {brands.map((b) => (
              <div key={b.id} className={`chip ${String(brandId) === String(b.id) ? "active" : ""}`} onClick={() => { setBrandId(b.id); setGroup(""); setVehicleId(""); }}>{b.name}</div>
            ))}
          </div>
        </aside>

        <section className="panel">
          <div className="filters" style={{ flexWrap: "wrap" }}>
            <input className="filter-code" placeholder="Pesquisar por código ou veí­culo (produto/OEM/Similar/Veículo)" value={codeQuery} onChange={(e)=>setCodeQuery(e.target.value)} />
            <select value={group} onChange={(e) => { setGroup(e.target.value); setVehicleId(""); }}>
              <option value="">Grupo (todos)</option>
              {groups.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
              <option value="">Veículo (todos)</option>
              {vehicles.map((v) => (<option key={v.id} value={v.id}>{v.name}</option>))}
            </select>
            <button onClick={doSearch}>Pesquisar</button>
          </div>
          <h3 style={{ marginTop: 0 }}>Resultados</h3>
          {results.length === 0 ? (
            <p className="auth-muted small">Use os filtros para buscar produtos.</p>
          ) : (
            <ul className="list">
              {results.map((p) => (
                <li key={p.id} onClick={() => openDetails(p.id)} className="item">
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, width: "100%" }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <span className="code">{p.code}</span>
                      <span className="desc">{p.description}</span>
                      <span className="brand">{p.brand}</span>
                    </div>
                    {p.vehicles && <div style={{ fontSize: 12, opacity: 0.9 }}>Aplicações: {p.vehicles}</div>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <h3 style={{ marginTop: 0 }}>Detalhes</h3>
          {!selected && <p>Selecione um produto</p>}
          {selected && (
            <div className="details-wrap">
              <p>
                <b>{selected.code}</b> - {selected.description}
                <br />
              </p>
              <div className="sep" />
              <div className="brand">
                <div className="subtitle">Marca:</div>
                <div className="brand-list">{selected.brand}</div>
              </div>
              <div className="sep" />
              {selected.application && (
                <div className="compat">
                  <div className="subtitle">Compatí­vel com:</div>
                  <div className="compat-list">{selected.application}</div>
                </div>
              )}
              <div className="sep" />
              {selected.details && (<div className="details-text">{selected.details}</div>)}
              <div className="sep" />
              {selected.similar && (
                <div className="similar">
                  <div className="subtitle">Similares:</div>
                  <div className="details-text">{selected.similar}</div>
                </div>
              )}
              <div className="grid">
                {imageUrls.map((u, i) => (
                  <img key={i} src={u} alt="produto" className="thumb" onClick={()=>setPreview({ open:true, index:i })} />
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
    {preview.open && imageUrls.length > 0 && (
      <div className="modal-backdrop" onClick={()=>setPreview({open:false, index:0})}>
        <button className="modal-close" aria-label="Fechar" title="Fechar" onClick={(e)=>{ e.stopPropagation(); setPreview({open:false, index:0}); }}>X</button>
        <img className="modal-image" src={imageUrls[preview.index]} alt="preview" onClick={(e)=>{ e.stopPropagation(); setPreview(p=>({ open:true, index:(p.index+1)%imageUrls.length })); }} />
      </div>
    )}
    {launchModal.open && launchImages.length > 0 && (
      <div className="launch-modal" onClick={() => setLaunchModal((m) => ({ ...m, open: false }))}>
        <div className="launch-modal-body" onClick={(e) => e.stopPropagation()}>
          <button className="launch-close" onClick={() => setLaunchModal((m) => ({ ...m, open: false }))}>X</button>
          <div className="launch-carousel">
            <button className="launch-arrow" onClick={() => shiftLaunch(-1)} aria-label="Anterior">‹</button>
            <img src={launchImages[launchModal.index]} alt="Lançamento" />
            <button className="launch-arrow" onClick={() => shiftLaunch(1)} aria-label="Próximo">›</button>
          </div>
          <div className="launch-counter">{launchModal.index + 1} / {launchImages.length}</div>
        </div>
      </div>
    )}
    {blockAccess && (
      <div className="auth-backdrop">
        <div className="auth-modal">
          <div className="auth-header">
            <div>
              <p className="auth-kicker">Acesso restrito</p>
              <h2>Meu Cadastro</h2>
              <p className="auth-muted">
                Envie a ficha e aguarde aprovação. Enquanto o status não for aprovado, o catálogo fica bloqueado.
              </p>
              <p className="auth-status">Status atual: {profileStatusLabel}</p>
            </div>
            <div className="auth-brand">CATÁLOGO IPS</div>
          </div>

          {!supabaseConfigured ? (
            <div className="auth-alert">
              Configure VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY no .env antes de liberar o acesso.
            </div>
          ) : (
            <>
              <section className="auth-section">
                <h3>Ficha de cadastro</h3>
                <p className="auth-muted">Envie seus dados; o time aprova manualmente e libera o acesso.</p>
                {submitted ? (
                  <div className="auth-wait">
                    <p><strong>Cadastro enviado.</strong> Aguarde aprovação do time.</p>
                    <p className="auth-muted small">Se precisar corrigir algo, reabra a ficha e reenvie.</p>
                  </div>
                ) : (
                  <form className="auth-grid" onSubmit={submitRegistration}>
                    <div className="auth-radio">
                      <label><input type="radio" name="personType" checked={registration.person_type === "pj"} onChange={()=>setRegistration((p)=>({ ...p, person_type: "pj" }))} /> Pessoa Jurídica</label>
                      <label><input type="radio" name="personType" checked={registration.person_type === "pf"} onChange={()=>setRegistration((p)=>({ ...p, person_type: "pf" }))} /> Pessoa Física</label>
                    </div>
                    <label className="auth-field wide">
                      Nome/Razão social
                      <input value={registration.full_name} onChange={(e)=>setRegistration((p)=>({ ...p, full_name: e.target.value }))} placeholder="Nome completo ou razão social" />
                    </label>
                    <label className="auth-field wide">
                      CPF/CNPJ
                      <input value={registration.cpf_cnpj} onChange={(e)=>setRegistration((p)=>({ ...p, cpf_cnpj: e.target.value }))} placeholder="000.000.000-00" />
                    </label>
                    <label className="auth-field">
                      País
                      <input value={registration.country} onChange={(e)=>setRegistration((p)=>({ ...p, country: e.target.value }))} placeholder="Brasil" />
                    </label>
                    <label className="auth-field">
                      Estado
                      <input value={registration.state} onChange={(e)=>setRegistration((p)=>({ ...p, state: e.target.value }))} placeholder="UF" />
                    </label>
                    <label className="auth-field">
                      Cidade
                      <input value={registration.city} onChange={(e)=>setRegistration((p)=>({ ...p, city: e.target.value }))} placeholder="Curitiba" />
                    </label>
                    <div className="auth-row-compact">
                      <label className="auth-field">
                        DDD
                        <input value={registration.phone_area} onChange={(e)=>setRegistration((p)=>({ ...p, phone_area: e.target.value }))} placeholder="41" />
                      </label>
                      <label className="auth-field">
                        Telefone
                        <input value={registration.phone_number} onChange={(e)=>setRegistration((p)=>({ ...p, phone_number: e.target.value }))} placeholder="999999999" />
                      </label>
                    </div>
                    <label className="auth-field wide">
                      E-mail
                      <input type="email" value={registration.email || authEmail} onChange={(e)=>setRegistration((p)=>({ ...p, email: e.target.value }))} placeholder="usuario@empresa.com" />
                    </label>
                    <div className="auth-meta">
                      <span>Código do cadastro: {profile?.id || "aguardando"}</span>
                      <span>Dispositivo vinculado: {profile?.device_fingerprint || deviceFingerprint}</span>
                    </div>
                    <button type="submit" disabled={savingProfile}>
                      {savingProfile ? "Enviando..." : "Enviar cadastro"}
                    </button>
                    <p className="auth-muted small">
                      Após enviar, o admin aprova manualmente. Caso troque de máquina, solicite nova aprovação ou reset do dispositivo.
                    </p>
                  </form>
                )}
              </section>

              {authMessage && <div className="auth-success">{authMessage}</div>}
              {authError && <div className="auth-error">{authError}</div>}
            </>
          )}
        </div>
      </div>
    )}
    {isAdminDev && (
      <>
        <div className="admin-fab">
          <button onClick={() => { loadPendingProfiles(); setShowAdminPanel((v) => !v); }}>
            {showAdminPanel ? "Fechar painel de aprovação" : "Aprovar cadastros (dev)"}
          </button>
        </div>
        {showAdminPanel && (
          <section className="panel admin-floating">
            <div className="admin-header">
              <h3>Painel (Dev) - Aprovar cadastros</h3>
              <span className="auth-muted small">Usa service_role; não publique esta chave.</span>
            </div>
            {adminError && <div className="auth-error">{adminError}</div>}
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <button onClick={loadPendingProfiles}>Atualizar</button>
            </div>
            {pendingProfiles.length === 0 && <p className="auth-muted small">Nenhum cadastro pendente.</p>}
            {pendingProfiles.length > 0 && (
              <ul className="admin-list">
                {pendingProfiles.map((p) => (
                  <li key={p.id}>
                    <div>
                      <strong>{p.full_name || "Sem nome"}</strong> - {p.email || "sem email"}
                      <div className="auth-muted small">CPF/CNPJ: {p.cpf_cnpj || "-"} | Cidade: {p.city || "-"} | Device: {p.device_fingerprint || "-"}</div>
                    </div>
                    <button onClick={() => approveProfile(p.id)}>Aprovar</button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </>
    )}
    </>
  );
}

export default App;









