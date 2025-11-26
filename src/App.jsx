import { useEffect, useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  initApp,
  fetchBrands,
  fetchVehicles,
  fetchGroups,
  fetchVehiclesFiltered,
  searchProducts,
  getProductDetails,
  syncFromManifest,
  indexImagesFromManifest,
  listLaunchImages,
  readImageBase64,
  importExcel,
  exportDbTo,
  setBrandingImage,
} from "./lib/api";
import { supabase, supabaseService, supabaseServiceKey } from "./lib/supabaseClient";
import "./App.css";

const REG_DEFAULT = {
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

function safeParseProfile(raw) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function normalizePath(base, maybeRelative) {
  if (!maybeRelative) return base;
  const absolute = maybeRelative.startsWith("/") || /^[A-Za-z]:\\/.test(maybeRelative);
  if (absolute) return maybeRelative.replace(/\\/g, "/");
  const sep = base.endsWith("/") || base.endsWith("\\") ? "" : "/";
  return `${base}${sep}${maybeRelative}`.replace(/\\/g, "/");
}

function toDisplaySrc(path) {
  if (!path) return "";
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  if (path.startsWith("/")) return path; // asset servido pelo front
  // Se for caminho absoluto de arquivo, usa convertFileSrc; senão assume arquivo em /images
  if (/^[A-Za-z]:\\/.test(path) || path.startsWith("\\\\")) return convertFileSrc(path);
  return `/images/${path.replace(/^\.?\/?images\/?/i, "")}`;
}

function compareVersions(a = "0.0.0", b = "0.0.0") {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  const max = Math.max(pa.length, pb.length);
  for (let i = 0; i < max; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

async function getAppVersion() {
  try {
    const mod = await import("@tauri-apps/api/app");
    if (mod?.getVersion) return await mod.getVersion();
  } catch (_) {
    /* ignore */
  }
  return import.meta.env.VITE_APP_VERSION || "0.0.0";
}

async function openExternal(path) {
  try {
    const opener = await import("@tauri-apps/plugin-opener");
    if (opener?.openPath) return opener.openPath(path);
    if (opener?.openUrl) return opener.openUrl(path);
  } catch (_) {
    // fallback
  }
  window.open(path, "_blank");
  return undefined;
}

function useFingerprint() {
  return useMemo(() => {
    const cached = localStorage.getItem("device.fingerprint");
    if (cached) return cached;
    const generated = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `dev-${Date.now()}-${Math.random()}`;
    localStorage.setItem("device.fingerprint", generated);
    return generated;
  }, []);
}

function App() {
  const fingerprint = useFingerprint();
  const cachedProfile = useMemo(() => safeParseProfile(localStorage.getItem("profile.cached")), []);
  const isDev = import.meta.env.MODE !== "production";

  const [ready, setReady] = useState(false);
  const [dataDir, setDataDir] = useState("");
  const [imagesDir, setImagesDir] = useState("");
  const [dbPath, setDbPath] = useState("");
  const [dbVersion, setDbVersion] = useState(0);
  const [appVersion, setAppVersion] = useState("0.0.0");

  const [brands, setBrands] = useState([]);
  const [groups, setGroups] = useState([]);
  const [vehicles, setVehicles] = useState([]);

  const [brandId, setBrandId] = useState("");
  const [group, setGroup] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [codeQuery, setCodeQuery] = useState("");
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(null);
  const [selectedImages, setSelectedImages] = useState([]);
  const [imageModal, setImageModal] = useState({ open: false, index: 0 });

  const [logoPath, setLogoPath] = useState(localStorage.getItem("ui.logoPath") || "");
  const [bgPath, setBgPath] = useState(localStorage.getItem("ui.bgPath") || "");

  const [statusMsg, setStatusMsg] = useState("");
  const [secondaryStatus, setSecondaryStatus] = useState("");
  const [syncing, setSyncing] = useState(false);

  const [updateInfo, setUpdateInfo] = useState(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);

  const [launchImages, setLaunchImages] = useState([]);
  const [launchState, setLaunchState] = useState({ open: false, index: 0, loading: false, error: "" });
  const [manifestInput, setManifestInput] = useState("");
  const [toolsMsg, setToolsMsg] = useState("");
  const [excelPath, setExcelPath] = useState("");
  const [exportPath, setExportPath] = useState("");
  const [logoInput, setLogoInput] = useState("");
  const [bgInput, setBgInput] = useState("");

  const [profile, setProfile] = useState(cachedProfile);
  const [authLoading, setAuthLoading] = useState(true);
  const [registrationEmail, setRegistrationEmail] = useState(localStorage.getItem("registration.email") || "");
  const [authSuccess, setAuthSuccess] = useState("");
  const [authError, setAuthError] = useState("");
  const [form, setForm] = useState({ ...REG_DEFAULT, email: registrationEmail });
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [sentOnce, setSentOnce] = useState(false);

  const [adminError, setAdminError] = useState("");
  const [pendingProfiles, setPendingProfiles] = useState([]);
  const [showAdmin, setShowAdmin] = useState(false);

  const supabaseConfigured = !!supabase;
  const supabaseServiceConfigured = !!supabaseService;

  const selectedBrand = useMemo(() => brands.find((b) => String(b.id) === String(brandId)) || null, [brands, brandId]);
  const numericBrandId = useMemo(() => {
    if (brandId === null || brandId === undefined || brandId === "") return null;
    const n = Number(brandId);
    return Number.isNaN(n) ? null : n;
  }, [brandId]);

  const manifestUrl = useMemo(() => localStorage.getItem("manifestUrl") || import.meta.env.VITE_DEFAULT_MANIFEST_URL || "", []);

  const blockAccess = useMemo(() => {
    if (isDev) return false; // Em desenvolvimento não bloquear pela aprovação
    if (!supabaseConfigured) return false;
    if (cachedProfile?.status === "approved") return false;
    if (profile?.status === "approved") return false;
    return true;
  }, [isDev, supabaseConfigured, cachedProfile, profile]);

  useEffect(() => {
    localStorage.setItem("registration.email", registrationEmail || "");
  }, [registrationEmail]);

  useEffect(() => {
    (async () => {
      setReady(false);
      try {
        const info = await initApp();
        setDataDir(info.data_dir || info.dataDir || "");
        setImagesDir(info.images_dir || "");
        setDbPath(info.db_path || "");
        setDbVersion(info.db_version || 0);
      } catch (e) {
        setStatusMsg(`Falha ao iniciar: ${e}`);
      }
      setManifestInput(manifestUrl);

      try {
        const v = await getAppVersion();
        setAppVersion(v || "0.0.0");
      } catch (_) {
        setAppVersion(import.meta.env.VITE_APP_VERSION || "0.0.0");
      }

      try {
        const [b, v] = await Promise.all([fetchBrands(), fetchVehicles()]);
        setBrands(b || []);
        setVehicles(v || []);
      } catch (e) {
        setStatusMsg(`Falha ao carregar catálogos: ${e}`);
      }

      if (manifestUrl) {
        try {
          const manifest = await fetch(manifestUrl).then((r) => (r.ok ? r.json() : null)).catch(() => null);
          if (manifest?.appVersion && compareVersions(manifest.appVersion, appVersion || "0.0.0") > 0) {
            setUpdateInfo({ availableVersion: manifest.appVersion, downloadUrl: manifest.appDownloadUrl || manifestUrl });
            setUpdateDismissed(false);
          } else {
            setUpdateInfo(null);
          }
        } catch (_) {
          /* ignore */
        }

        try {
          setSyncing(true);
          const res = await syncFromManifest(manifestUrl);
          setDbVersion(res?.db_version || res?.dbVersion || dbVersion);
          setStatusMsg(`Sincronizado: db v${res?.db_version || res?.dbVersion || "?"} | imgs +${res?.downloaded_images || res?.downloadedImages || 0}`);
          localStorage.setItem("manifestUrl", manifestUrl);
        } catch (e) {
          setStatusMsg(`Falha ao sincronizar: ${e}`);
        } finally {
          setSyncing(false);
        }

        try {
          const idxRes = await indexImagesFromManifest(manifestUrl);
          setSecondaryStatus(`Indexados ${idxRes?.matched || 0}/${idxRes?.scanned || 0} imagens.`);
        } catch (e) {
          setSecondaryStatus(`Falha ao indexar: ${e}`);
        }
      }

      try {
        const branding = await fetch("/images/branding.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (branding?.logo && !logoPath) setLogoPath(`/images/${branding.logo}`);
        if (branding?.background && !bgPath) setBgPath(`/images/${branding.background}`);
      } catch (_) {
        /* ignore */
      }

      setReady(true);
    })();
  }, [manifestUrl]);

  useEffect(() => {
    if (!supabaseConfigured) {
      setAuthLoading(false);
      return;
    }
    (async () => {
      setAuthLoading(true);
      setAuthError("");
      try {
        const { data, error } = await supabase
          .from("profiles")
          .select("id,status,person_type,country,state,city,cpf_cnpj,full_name,phone_area,phone_number,email,device_fingerprint")
          .or(`device_fingerprint.eq.${fingerprint}${registrationEmail ? `,email.eq.${registrationEmail}` : ""}`)
          .maybeSingle();
        if (error && error.code !== "PGRST116") throw error;
        if (data) {
          setProfile(data);
          setForm((prev) => ({
            ...prev,
            person_type: data.person_type || prev.person_type,
            country: data.country || prev.country,
            state: data.state || prev.state,
            city: data.city || prev.city,
            cpf_cnpj: data.cpf_cnpj || prev.cpf_cnpj,
            full_name: data.full_name || prev.full_name,
            phone_area: data.phone_area || prev.phone_area,
            phone_number: data.phone_number || prev.phone_number,
            email: data.email || prev.email || registrationEmail,
          }));
          if (data.status === "approved") {
            localStorage.setItem("profile.cached", JSON.stringify(data));
          }
        }
      } catch (e) {
        setAuthError(`Falha ao carregar cadastro: ${e.message || e}`);
      } finally {
        setAuthLoading(false);
      }
    })();
  }, [supabaseConfigured, fingerprint, registrationEmail]);

  useEffect(() => {
    if (!supabaseServiceConfigured) return;
    (async () => {
      try {
        const { data, error } = await supabaseService
          .from("profiles")
          .select("id,full_name,email,cpf_cnpj,city,device_fingerprint,status")
          .eq("status", "pending")
          .limit(50);
        if (error) throw error;
        setPendingProfiles(data || []);
      } catch (e) {
        setAdminError(e.message || String(e));
      }
    })();
  }, [supabaseServiceConfigured]);

  useEffect(() => {
    const handler = (ev) => {
      if (!launchState.open) return;
      if (ev.key === "Escape") setLaunchState((s) => ({ ...s, open: false }));
      if (ev.key === "ArrowRight") cycleLaunch(1);
      if (ev.key === "ArrowLeft") cycleLaunch(-1);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [launchState.open, launchImages.length]);

  useEffect(() => {
    (async () => {
      try {
        const g = await fetchGroups(numericBrandId, selectedBrand ? selectedBrand.name : null);
        setGroups(g || []);
      } catch (e) {
        setStatusMsg(`Falha ao carregar grupos: ${e}`);
      }
      try {
        const v = await fetchVehiclesFiltered(numericBrandId, group || null);
        setVehicles(v || []);
      } catch (_) {
        /* ignore */
      }
    })();
  }, [numericBrandId, selectedBrand, group]);

  useEffect(() => {
    setSelected(null);
    setSelectedImages([]);
    setImageModal({ open: false, index: 0 });
    const t = setTimeout(() => {
      doSearch();
    }, 250);
    return () => clearTimeout(t);
  }, [numericBrandId, group, vehicleId, codeQuery]);

  useEffect(() => {
    if (!imagesDir) return;
    loadLaunches(true);
  }, [imagesDir]);

  async function submitRegistration(ev) {
    ev?.preventDefault();
    setAuthSuccess("");
    setAuthError("");
    setFormSubmitting(true);
    try {
      if (!supabase) throw new Error("Supabase não configurado.");
      let profileId = profile?.id || null;
      if (!profileId && (form.email || registrationEmail)) {
        const { data } = await supabase.from("profiles").select("id").eq("email", form.email || registrationEmail).maybeSingle();
        if (data?.id) profileId = data.id;
      }
      const payload = {
        ...form,
        email: form.email || registrationEmail || "",
        status: "pending",
        device_fingerprint: profile?.device_fingerprint || fingerprint,
        id: profileId || undefined,
      };
      const { data, error } = await supabase.from("profiles").upsert(payload, { onConflict: "email" }).select().maybeSingle();
      if (error) throw error;
      setProfile(data);
      setAuthSuccess("Cadastro enviado. Aguarde aprovação do time.");
      setSentOnce(true);
      if (data?.status === "approved") localStorage.setItem("profile.cached", JSON.stringify(data));
    } catch (e) {
      setAuthError(`Falha ao salvar cadastro: ${e.message || e}`);
    } finally {
      setFormSubmitting(false);
    }
  }

  async function approveProfile(id) {
    if (!supabaseService || !supabaseServiceKey) {
      setAdminError("Service role não configurado (apenas dev).");
      return;
    }
    try {
      const { error } = await supabaseService.from("profiles").update({ status: "approved" }).eq("id", id);
      if (error) throw error;
      setPendingProfiles((prev) => prev.filter((p) => p.id !== id));
    } catch (e) {
      setAdminError(e.message || String(e));
    }
  }

  async function doSearch() {
    if (!numericBrandId && !group && !vehicleId && !codeQuery) {
      setResults([]);
      return;
    }
    setStatusMsg("");
    try {
      const res = await searchProducts({
        brand_id: numericBrandId,
        group: group || null,
        vehicle_id: vehicleId ? Number(vehicleId) : null,
        code_query: codeQuery || null,
        limit: 200,
      });
      setResults(res || []);
    } catch (e) {
      setStatusMsg(`Falha ao buscar: ${e}`);
    }
  }

  async function openDetails(productId) {
    try {
      const detail = await getProductDetails(productId);
      setSelected(detail);
      if (!detail?.images) {
        setSelectedImages([]);
        return;
      }
      const unique = new Set();
      const imgs = [];
      for (const img of detail.images) {
        const normalized = normalizePath(imagesDir, img);
        try {
          const b64 = await readImageBase64(normalized);
          if (b64 && !unique.has(b64)) {
            unique.add(b64);
            imgs.push(b64);
          }
        } catch (e) {
          const fallback = convertFileSrc(normalized.startsWith("/") ? normalized : normalized);
          if (!unique.has(fallback)) {
            unique.add(fallback);
            imgs.push(fallback);
          }
        }
      }
      setSelectedImages(imgs);
    } catch (e) {
      setStatusMsg(`Falha ao carregar detalhes: ${e}`);
    }
  }

  async function loadLaunches(auto = false) {
    setLaunchState((s) => ({ ...s, loading: true, error: "" }));
    try {
      if (!imagesDir) {
        setLaunchState((s) => ({ ...s, loading: false, error: "Pasta de imagens não localizada." }));
        return;
      }
      const files = await listLaunchImages();
      if (!files || files.length === 0) {
        setLaunchImages([]);
        setLaunchState((s) => ({ ...s, loading: false, error: "Nenhuma imagem de lançamento encontrada." }));
        return;
      }
      const list = [];
      const uniq = new Set();
      for (const f of files) {
        const full = normalizePath(imagesDir, f);
        try {
          const b64 = await readImageBase64(full);
          if (b64 && !uniq.has(b64)) {
            uniq.add(b64);
            list.push(b64);
          }
        } catch (_) {
          const fallback = convertFileSrc(full);
          if (!uniq.has(fallback)) {
            uniq.add(fallback);
            list.push(fallback);
          }
        }
      }
      setLaunchImages(list);
      // Sempre abre o modal quando a lista é carregada manualmente; em auto-init também abrimos para exibir novidades
      setLaunchState((s) => ({ ...s, loading: false, open: true, index: 0 }));
    } catch (e) {
      setLaunchImages([]);
      setLaunchState({ open: false, index: 0, loading: false, error: `Falha ao carregar Lançamentos: ${e.message || e}` });
    }
  }

  async function runSync(manUrl) {
    const target = manUrl || manifestUrl;
    if (!target) return;
    setToolsMsg("");
    setSyncing(true);
    try {
      const res = await syncFromManifest(target);
      setDbVersion(res?.db_version || res?.dbVersion || dbVersion);
      localStorage.setItem("manifestUrl", target);
      setStatusMsg(`Sincronizado: db v${res?.db_version || res?.dbVersion || "?"} | imgs +${res?.downloaded_images || res?.downloadedImages || 0}`);
      setToolsMsg("Sync concluído.");
    } catch (e) {
      setToolsMsg(`Falha ao sincronizar: ${e}`);
    } finally {
      setSyncing(false);
    }
  }

  async function runIndex(manUrl) {
    const target = manUrl || manifestUrl;
    if (!target) return;
    setToolsMsg("Indexando imagens via manifest...");
    try {
      const idxRes = await indexImagesFromManifest(target);
      setToolsMsg(`Indexados ${idxRes?.matched || 0}/${idxRes?.scanned || 0} imagens.`);
    } catch (e) {
      setToolsMsg(`Falha ao indexar: ${e}`);
    }
  }

  async function runImportExcel() {
    try {
      const picked = await openDialog({ multiple: false, filters: [{ name: "Excel", extensions: ["xlsx", "xls"] }] });
      if (!picked || Array.isArray(picked)) return;
      setExcelPath(picked);
      setToolsMsg("Importando Excel...");
      const res = await importExcel(picked);
      setToolsMsg(`Importado: linhas ${res?.processed_rows ?? "?"}, produtos ${res?.upserted_products ?? "?"}, versão db ${res?.new_db_version ?? "?"}`);
    } catch (e) {
      setToolsMsg(`Falha ao importar Excel: ${e}`);
    }
  }

  async function runExportDb() {
    try {
      const picked = await saveDialog({ defaultPath: "catalog.db" });
      if (!picked) return;
      setExportPath(picked);
      setToolsMsg("Exportando banco...");
      const res = await exportDbTo(picked);
      setToolsMsg(res?.ok ? `DB exportado: ${res.output || picked}` : "Falha ao exportar");
    } catch (e) {
      setToolsMsg(`Falha ao exportar: ${e}`);
    }
  }

  async function runSetBranding(kind) {
    try {
      const picked = await openDialog({ multiple: false, filters: [{ name: "Imagens", extensions: ["png", "jpg", "jpeg", "webp"] }] });
      if (!picked || Array.isArray(picked)) return;
      setToolsMsg(`Aplicando ${kind}...`);
      const res = await setBrandingImage(kind, picked);
      const returnedPath = kind === "logo" ? res?.logo : res?.background;
      const finalPath = returnedPath || picked;
      if (kind === "logo") {
        localStorage.setItem("ui.logoPath", finalPath);
        setLogoPath(finalPath);
        setLogoInput(finalPath);
      } else {
        localStorage.setItem("ui.bgPath", finalPath);
        setBgPath(finalPath);
        setBgInput(finalPath);
      }
      setToolsMsg(res?.ok ? `${kind} atualizado` : `Falha ao atualizar ${kind}`);
    } catch (e) {
      setToolsMsg(`Falha ao atualizar ${kind}: ${e}`);
    }
  }

  function cycleLaunch(delta) {
    if (!launchImages.length) return;
    setLaunchState((s) => ({ ...s, open: true, index: (s.index + delta + launchImages.length) % launchImages.length }));
  }

  const headerBgStyle = bgPath
    ? { backgroundImage: `url(${toDisplaySrc(bgPath)})`, backgroundSize: "cover", backgroundPosition: "center", backgroundRepeat: "no-repeat" }
    : undefined;

  if (!ready) {
    return (
      <main className="container" style={headerBgStyle}>
        Carregando...
      </main>
    );
  }

  return (
    <>
      <main className={`container ${blockAccess ? "app-blocked" : ""}`} style={headerBgStyle}>
        <div className="appbar">
          <div>{logoPath ? <img className="logo" src={toDisplaySrc(logoPath)} alt="Logo" /> : null}</div>
          <h1>Catálogo IPS</h1>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            {updateInfo && !updateDismissed && (
              <div className="update-banner">
                <span>
                  Nova versão disponível: {updateInfo.availableVersion} (atual {appVersion})
                </span>
                {updateInfo.downloadUrl ? (
                  <button onClick={() => openExternal(updateInfo.downloadUrl)}>Baixar/Atualizar</button>
                ) : null}
                <button className="ghost" onClick={() => setUpdateDismissed(true)}>
                  Fechar
                </button>
              </div>
            )}
            <div className="social-block">
              <nav className="social-links">
                <a href="https://www.instagram.com/ipsbrasiloficial/" target="_blank" rel="noreferrer" aria-label="Instagram">
                  <svg viewBox="0 0 24 24"><path d="M7 3h10a4 4 0 014 4v10a4 4 0 01-4 4H7a4 4 0 01-4-4V7a4 4 0 014-4zm0 2a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2H7zm11.5 1a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM12 8.5A3.5 3.5 0 1112 15.5 3.5 3.5 0 0112 8.5zm0 2a1.5 1.5 0 100 3 1.5 1.5 0 000-3z" /></svg>
                </a>
                <a href="https://www.youtube.com/@MKTIPS-t8t" target="_blank" rel="noreferrer" aria-label="YouTube">
                  <svg viewBox="0 0 24 24"><path d="M21.8 8s-.2-1.4-.8-2c-.7-.8-1.5-.8-1.9-.9C16.2 5 12 5 12 5h0s-4.2 0-7.1.1c-.4 0-1.3.1-1.9.9-.6.6-.8 2-.8 2S2 9.6 2 11.1v1.7C2 14.4 2.2 16 2.2 16s.2 1.4.8 2c.7.8 1.7.7 2.1.8 1.5.1 6.9.1 6.9.1s4.2 0 7.1-.1c.4 0 1.3-.1 1.9-.9.6-.6.8-2 .8-2s.2-1.6.2-3.2v-1.7c0-1.5-.2-3.1-.2-3.1zM10 14.7V8.8l5 2.9-5 3z" /></svg>
                </a>
                <a href="mailto:contato@ipsbrasil.com.br" aria-label="Email">
                  <svg viewBox="0 0 24 24"><path d="M4 4h16a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2zm0 2v.2l8 4.8 8-4.8V6H4zm0 3.3V18h16V9.3l-8 4.8-8-4.8z" /></svg>
                </a>
              </nav>
              <button className="launch-button" onClick={() => loadLaunches(false)} disabled={launchState.loading}>
                {launchState.loading ? "Carregando..." : "Lançamentos"}
              </button>
              {launchState.error ? <span className="launch-error">{launchState.error}</span> : null}
            </div>
          </div>
        </div>

        {isDev && (
          <div className="tools" style={{ width: "100%", maxWidth: 1280, margin: "0 auto" }}>
            <details>
              <summary>Ferramentas (dev)</summary>
              <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, marginTop: 8, alignItems: "center" }}>
                <input placeholder="URL do manifest" value={manifestInput} onChange={(e) => setManifestInput(e.target.value)} />
                <button disabled={syncing || !manifestInput} onClick={() => runSync(manifestInput)}>
                  {syncing ? "Sincronizando..." : "Sincronizar"}
                </button>
                <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8 }}>
                  <button onClick={() => runIndex(manifestInput)} disabled={!manifestInput || syncing}>
                    Indexar imagens (manifest)
                  </button>
                  <button onClick={() => loadLaunches(true)} disabled={launchState.loading}>
                    Abrir lançamentos
                  </button>
                </div>
                <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button onClick={runImportExcel}>Importar Excel</button>
                  {excelPath ? <span style={{ fontSize: 12, color: "#555" }}>Último: {excelPath}</span> : null}
                  <button onClick={runExportDb}>Exportar DB</button>
                  {exportPath ? <span style={{ fontSize: 12, color: "#555" }}>Último: {exportPath}</span> : null}
                  <button onClick={() => runSetBranding("logo")}>Aplicar logo</button>
                  {logoInput ? <span style={{ fontSize: 12, color: "#555" }}>Atual: {logoInput}</span> : null}
                  <button onClick={() => runSetBranding("background")}>Aplicar fundo</button>
                  {bgInput ? <span style={{ fontSize: 12, color: "#555" }}>Atual: {bgInput}</span> : null}
                </div>
                {toolsMsg && <span style={{ gridColumn: "1 / -1", fontSize: 12, color: "#444" }}>{toolsMsg}</span>}
              </div>
            </details>
          </div>
        )}

        {(statusMsg || secondaryStatus || syncing) && (
          <div className="statusbar">
            <div className="small">{syncing ? "Sincronizando... " : ""}{statusMsg}</div>
            {secondaryStatus ? <div className="small">{secondaryStatus}</div> : null}
            <button style={{ marginLeft: 8, marginTop: 6, padding: "2px 6px", borderRadius: 6, border: 0, cursor: "pointer" }} onClick={() => { setStatusMsg(""); setSecondaryStatus(""); }}>
              X
            </button>
          </div>
        )}

        <div className="layout">
          <aside className="sidebar">
            <h3>Fabricantes</h3>
            <div className="chips">
              <div className={`chip ${!brandId ? "active" : ""}`} onClick={() => { setBrandId(""); setGroup(""); setVehicleId(""); }}>
                Todos
              </div>
              {brands.map((b) => (
                <div key={b.id} className={`chip ${String(brandId) === String(b.id) ? "active" : ""}`} onClick={() => { setBrandId(b.id); setGroup(""); setVehicleId(""); }}>
                  {b.name}
                </div>
              ))}
            </div>
          </aside>

          <section className="panel">
            <div className="filters" style={{ flexWrap: "wrap" }}>
              <input className="filter-code" placeholder="Pesquisar por código ou veículo (produto/OEM/Similar/Veículo)" value={codeQuery} onChange={(e) => setCodeQuery(e.target.value)} />
              <select value={group} onChange={(e) => { setGroup(e.target.value); setVehicleId(""); }}>
                <option value="">Grupo (todos)</option>
                {groups.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
              <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
                <option value="">Veículo (todos)</option>
                {vehicles.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
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
                      {p.vehicles ? <div style={{ fontSize: 12, opacity: 0.9 }}>Aplicações: {p.vehicles}</div> : null}
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
                    <div className="subtitle">Compatível com:</div>
                    <div className="compat-list">{selected.application}</div>
                  </div>
                )}
                {selected.details ? (
                  <>
                    <div className="sep" />
                    <div className="details-text">{selected.details}</div>
                  </>
                ) : null}
                {selected.similar ? (
                  <>
                    <div className="sep" />
                    <div className="similar">
                      <div className="subtitle">Similares:</div>
                      <div className="details-text">{selected.similar}</div>
                    </div>
                  </>
                ) : null}
                <div className="grid">
                  {selectedImages.map((src, idx) => (
                    <img key={idx} src={src} alt="produto" className="thumb" onClick={() => setImageModal({ open: true, index: idx })} />
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>
      </main>

      {imageModal.open && selectedImages.length > 0 && (
        <div className="modal-backdrop" onClick={() => setImageModal({ open: false, index: 0 })}>
          <button className="modal-close" aria-label="Fechar" title="Fechar" onClick={(e) => { e.stopPropagation(); setImageModal({ open: false, index: 0 }); }}>
            X
          </button>
          <img className="modal-image" src={selectedImages[imageModal.index]} alt="preview" onClick={(e) => { e.stopPropagation(); setImageModal((s) => ({ open: true, index: (s.index + 1) % selectedImages.length })); }} />
        </div>
      )}

      {launchState.open && launchImages.length > 0 && (
        <div className="launch-modal" onClick={() => setLaunchState((s) => ({ ...s, open: false }))}>
          <div className="launch-modal-body" onClick={(e) => e.stopPropagation()}>
            <button className="launch-close" onClick={() => setLaunchState((s) => ({ ...s, open: false }))}>
              X
            </button>
            <div className="launch-carousel">
              <button className="launch-arrow" onClick={() => cycleLaunch(-1)} aria-label="Anterior">
                &lt;
              </button>
              <img src={launchImages[launchState.index]} alt="lançamento" />
              <button className="launch-arrow" onClick={() => cycleLaunch(1)} aria-label="Próximo">
                &gt;
              </button>
            </div>
            <div className="launch-counter">{launchState.index + 1} / {launchImages.length}</div>
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
                <p className="auth-muted">Envie a ficha e aguarde aprovação. Enquanto o status não for aprovado, o catálogo fica bloqueado.</p>
                <p className="auth-status">Status atual: {profile?.status || "pending"}</p>
              </div>
              <div className="auth-brand">CATÁLOGO IPS</div>
            </div>

            {supabaseConfigured ? (
              <>
                <section className="auth-section">
                  <h3>Ficha de cadastro</h3>
                  <p className="auth-muted">Envie seus dados; o time aprova manualmente e libera o acesso.</p>

                  {sentOnce ? (
                    <div className="auth-wait">
                      <p><strong>Cadastro enviado.</strong> Aguarde aprovação do time.</p>
                      <p className="auth-muted small">Se precisar corrigir algo, reabra a ficha e reenvie.</p>
                    </div>
                  ) : (
                    <form className="auth-grid" onSubmit={submitRegistration}>
                      <div className="auth-radio">
                        <label>
                          <input type="radio" name="personType" checked={form.person_type === "pj"} onChange={() => setForm((s) => ({ ...s, person_type: "pj" }))} /> Pessoa Jurídica
                        </label>
                        <label>
                          <input type="radio" name="personType" checked={form.person_type === "pf"} onChange={() => setForm((s) => ({ ...s, person_type: "pf" }))} /> Pessoa Física
                        </label>
                      </div>

                      <label className="auth-field wide">
                        Nome/Razão social
                        <input value={form.full_name} onChange={(e) => setForm((s) => ({ ...s, full_name: e.target.value }))} placeholder="Nome completo ou razão social" />
                      </label>
                      <label className="auth-field wide">
                        CPF/CNPJ
                        <input value={form.cpf_cnpj} onChange={(e) => setForm((s) => ({ ...s, cpf_cnpj: e.target.value }))} placeholder="000.000.000-00" />
                      </label>

                      <label className="auth-field">
                        País
                        <input value={form.country} onChange={(e) => setForm((s) => ({ ...s, country: e.target.value }))} placeholder="Brasil" />
                      </label>
                      <label className="auth-field">
                        Estado
                        <input value={form.state} onChange={(e) => setForm((s) => ({ ...s, state: e.target.value }))} placeholder="UF" />
                      </label>
                      <label className="auth-field">
                        Cidade
                        <input value={form.city} onChange={(e) => setForm((s) => ({ ...s, city: e.target.value }))} placeholder="Curitiba" />
                      </label>

                      <div className="auth-row-compact">
                        <label className="auth-field">
                          DDD
                          <input value={form.phone_area} onChange={(e) => setForm((s) => ({ ...s, phone_area: e.target.value }))} placeholder="41" />
                        </label>
                        <label className="auth-field">
                          Telefone
                          <input value={form.phone_number} onChange={(e) => setForm((s) => ({ ...s, phone_number: e.target.value }))} placeholder="999999999" />
                        </label>
                      </div>

                      <label className="auth-field wide">
                        E-mail
                        <input type="email" value={form.email || registrationEmail} onChange={(e) => setForm((s) => ({ ...s, email: e.target.value }))} placeholder="usuario@empresa.com" />
                      </label>

                      <div className="auth-meta">
                        <span>Código do cadastro: {profile?.id || "aguardando"}</span>
                        <span>Dispositivo vinculado: {profile?.device_fingerprint || fingerprint}</span>
                      </div>

                      <button type="submit" disabled={formSubmitting}>
                        {formSubmitting ? "Enviando..." : "Enviar cadastro"}
                      </button>
                      <p className="auth-muted small">Após enviar, o admin aprova manualmente. Caso troque de máquina, solicite nova aprovação ou reset do dispositivo.</p>
                    </form>
                  )}
                </section>

                {authSuccess && <div className="auth-success">{authSuccess}</div>}
                {authError && <div className="auth-error">{authError}</div>}
              </>
            ) : (
              <div className="auth-alert">Configure VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY no .env antes de liberar o acesso.</div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export default App;





