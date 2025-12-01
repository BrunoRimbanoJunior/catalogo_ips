import { useEffect, useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  initApp,
  getProductDetails,
  syncFromManifest,
  indexImagesFromManifest,
  listLaunchImages,
  readImageBase64,
  importExcel,
  exportDbTo,
  setBrandingImage,
  setHeaderLogos as setHeaderLogosApi,
} from "./lib/api";
import { loadInitialCatalog, loadGroups, loadVehiclesByFilters, searchWithFilters } from "./lib/catalogData";
import {
  DEFAULT_BACKGROUND,
  DEFAULT_LOGO,
  HEADER_LOGO_PREFIX,
  compareVersions,
  getAppVersion,
  normalizePath,
  parseStoredArray,
  sanitizeStoredPath,
  safeParseProfile,
  toDisplaySrc,
  toHeaderLogoPath,
} from "./lib/catalogUtils";
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

// Apenas para exibir no dropdown: remove tokens com dígitos (anos/códigos) mantendo nome base.
function vehicleLabel(name = "") {
  const parts = String(name).split(/\s+/);
  const kept = [];
  for (const p of parts) {
    if (!p) continue;
    if (/\d/.test(p) || p.includes("(")) break;
    kept.push(p);
  }
  const out = kept.join(" ").trim();
  return out || name;
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
  const [makes, setMakes] = useState([]);
  const [groups, setGroups] = useState([]);
  const [vehicles, setVehicles] = useState([]);

  const [brandId, setBrandId] = useState("");
  const [brandName, setBrandName] = useState("");
  const [group, setGroup] = useState("");
  const [make, setMake] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [codeQuery, setCodeQuery] = useState("");
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(null);
  const [selectedImages, setSelectedImages] = useState([]);
  const [imageModal, setImageModal] = useState({ open: false, index: 0 });

  const [logoPath, setLogoPath] = useState(() => sanitizeStoredPath(localStorage.getItem("ui.logoPath"), DEFAULT_LOGO));
  const [bgPath, setBgPath] = useState(() => sanitizeStoredPath(localStorage.getItem("ui.bgPath"), DEFAULT_BACKGROUND));
  const [headerLogos, setHeaderLogos] = useState(() => parseStoredArray(localStorage.getItem("ui.headerLogos")));

  const loadGroupsFor = async (bid, bname) => {
    try {
      const coerced = bid === null || bid === undefined || bid === "" ? null : Number(bid);
      const g = await fetchGroups(coerced, bname || null);
      setGroups((g || []).filter(Boolean));
    } catch (e) {
      setStatusMsg(`Falha ao carregar grupos: ${e}`);
    }
  };

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
  const [allowAfterDelay, setAllowAfterDelay] = useState(false);

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

  const DEFAULT_MANIFEST_URL = "https://raw.githubusercontent.com/BrunoRimbanoJunior/catalogo_ips/main/manifest.json";
  const manifestUrl = useMemo(
    () => localStorage.getItem("manifestUrl") || import.meta.env.VITE_DEFAULT_MANIFEST_URL || DEFAULT_MANIFEST_URL,
    []
  );
  const FIXED_DOWNLOAD = "https://1drv.ms/u/c/4e4e660955b19ef5/EdHos0VU9D5BihkzIiMhhUEB0skBGWNpeQvmVQhspQj-7g?e=Vm1ixV";

  const blockAccess = useMemo(() => {
    if (isDev) return false; // Em desenvolvimento nao bloquear pela aprovacao
    if (cachedProfile?.status === "block" || profile?.status === "block") return true;
    if (allowAfterDelay) return false;
    if (cachedProfile?.status === "approved" || profile?.status === "approved") return false;
    return true;
  }, [isDev, supabaseConfigured, cachedProfile, profile, allowAfterDelay]);

  useEffect(() => {
    localStorage.setItem("registration.email", registrationEmail || "");
  }, [registrationEmail]);

  useEffect(() => {
    if (logoPath) localStorage.setItem("ui.logoPath", logoPath);
  }, [logoPath]);

  useEffect(() => {
    if (bgPath) localStorage.setItem("ui.bgPath", bgPath);
  }, [bgPath]);

  useEffect(() => {
    localStorage.setItem("ui.headerLogos", JSON.stringify(headerLogos || []));
  }, [headerLogos]);

  useEffect(() => {
    if (!supabaseConfigured) return;
    if (profile?.status === "block" || cachedProfile?.status === "block") {
      setAllowAfterDelay(false);
      return;
    }
    if (profile?.status === "approved" || cachedProfile?.status === "approved") {
      setAllowAfterDelay(true);
      return;
    }
    if (sentOnce) setAllowAfterDelay(false);
  }, [supabaseConfigured, profile, cachedProfile, sentOnce]);

  useEffect(() => {
    const src = toDisplaySrc(logoPath || DEFAULT_LOGO);
    if (!src) return;
    const img = new Image();
    img.onerror = () => {
      if (logoPath !== DEFAULT_LOGO) {
        setLogoPath(DEFAULT_LOGO);
        localStorage.setItem("ui.logoPath", DEFAULT_LOGO);
      }
    };
    img.src = src;
    return () => {
      img.onerror = null;
    };
  }, [logoPath]);

  useEffect(() => {
    const src = toDisplaySrc(bgPath || DEFAULT_BACKGROUND);
    if (!src) return;
    const img = new Image();
    img.onerror = () => {
      if (bgPath !== DEFAULT_BACKGROUND) {
        setBgPath(DEFAULT_BACKGROUND);
        localStorage.setItem("ui.bgPath", DEFAULT_BACKGROUND);
      }
    };
    img.src = src;
    return () => {
      img.onerror = null;
    };
  }, [bgPath]);

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
        const { brands: b, vehicles: v, makes: mk } = await loadInitialCatalog();
        setBrands(b);
        setVehicles(v);
        setMakes(mk);
        await loadGroupsFor(null, null);
      } catch (e) {
        setStatusMsg(`Falha ao carregar catalogos: ${e}`);
      }

      // Libera UI assim que dados base carregam; sync/branding continuam em paralelo
      setReady(true);

      if (manifestUrl) {
        try {
          const manifest = await fetch(manifestUrl).then((r) => (r.ok ? r.json() : null)).catch(() => null);
          if (manifest?.appVersion && compareVersions(manifest.appVersion, appVersion || "0.0.0") > 0) {
            setUpdateInfo({ availableVersion: manifest.appVersion, downloadUrl: FIXED_DOWNLOAD });
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
        const brandingLogo = branding?.logo ? `/images/${branding.logo}` : null;
        const brandingBg = branding?.background ? `/images/${branding.background}` : null;
        const brandingHeaders = Array.isArray(branding?.headerLogos)
          ? branding.headerLogos
              .map((n) => toHeaderLogoPath(n))
              .filter((p) => p && typeof p === "string")
          : [];

        if (brandingLogo && (logoPath === DEFAULT_LOGO || !logoPath)) {
          setLogoPath(brandingLogo);
          localStorage.setItem("ui.logoPath", brandingLogo);
        }
        if (brandingBg && (bgPath === DEFAULT_BACKGROUND || !bgPath)) {
          setBgPath(brandingBg);
          localStorage.setItem("ui.bgPath", brandingBg);
        }
        if (brandingHeaders.length && headerLogos.length === 0) {
          setHeaderLogos(brandingHeaders);
          localStorage.setItem("ui.headerLogos", JSON.stringify(brandingHeaders));
        }
      } catch (_) {
        /* ignore */
      }
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
        const g = await loadGroups(numericBrandId, selectedBrand ? selectedBrand.name : null);
        setGroups(g || []);
      } catch (e) {
        setStatusMsg(`Falha ao carregar grupos: ${e}`);
      }
      try {
        const v = await loadVehiclesByFilters(numericBrandId, group || null, make || null);
        setVehicles(v || []);
      } catch (_) {
        /* ignore */
      }
    })();
  }, [numericBrandId, selectedBrand, group, make]);

  useEffect(() => {
    setSelected(null);
    setSelectedImages([]);
    setImageModal({ open: false, index: 0 });
    const t = setTimeout(() => {
      doSearch();
    }, 250);
    return () => clearTimeout(t);
  }, [numericBrandId, group, vehicleId, codeQuery, make]);

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
      if (!supabase) throw new Error("Supabase nao configurado.");
      let profileId = profile?.id || null;
      if (!profileId && (form.email || registrationEmail)) {
        const { data } = await supabase.from("profiles").select("id").eq("email", form.email || registrationEmail).maybeSingle();
        if (data?.id) profileId = data.id;
      }
      const payload = {
        ...form,
        email: form.email || registrationEmail || "",
        status: "approved",
        device_fingerprint: profile?.device_fingerprint || fingerprint,
        id: profileId || undefined,
      };
      const { data, error } = await supabase.from("profiles").upsert(payload, { onConflict: "email" }).select().maybeSingle();
      if (error) throw error;
      const resolved = data ? { ...data, status: "approved" } : null;
      if (resolved) {
        setProfile(resolved);
        localStorage.setItem("profile.cached", JSON.stringify(resolved));
      }
      setAuthSuccess("Cadastro enviado. Aguarde aprovacao.");
      setSentOnce(true);
      setAllowAfterDelay(false);
      setTimeout(() => setAllowAfterDelay(true), 3000);
    } catch (e) {
      setAuthError(`Falha ao salvar cadastro: ${e.message || e}`);
    } finally {
      setFormSubmitting(false);
    }
  }

  async function approveProfile(id) {
    if (!supabaseService || !supabaseServiceKey) {
      setAdminError("Service role nao configurado (apenas dev).");
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
      const res = await searchWithFilters({
        brandId: numericBrandId,
        group,
        vehicleId,
        make,
        codeQuery,
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
      const codeStr = detail?.code ? String(detail.code) : "";
      const listFiltered =
        codeStr && Array.isArray(detail.images) && detail.images.length
          ? detail.images.filter((img) => {
              const lower = String(img || "").toLowerCase();
              return lower.includes(codeStr.toLowerCase());
            })
          : detail.images;
      const imagesList = listFiltered && listFiltered.length ? listFiltered : detail.images;
      const unique = new Set();
      const imgs = [];
      for (const img of imagesList) {
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
        setLaunchState((s) => ({ ...s, loading: false, error: "Pasta de imagens nao localizada." }));
        return;
      }
      const files = await listLaunchImages();
      if (!files || files.length === 0) {
        setLaunchImages([]);
        setLaunchState((s) => ({ ...s, loading: false, error: "Nenhuma imagem de lancamento encontrada." }));
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
      // Sempre abre o modal quando a lista ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¿ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â½ carregada manualmente; em auto-init tambÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¿ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â½m abrimos para exibir novidades
      setLaunchState((s) => ({ ...s, loading: false, open: true, index: 0 }));
    } catch (e) {
      setLaunchImages([]);
      setLaunchState({ open: false, index: 0, loading: false, error: `Falha ao carregar lancamentos: ${e.message || e}` });
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
      setToolsMsg("Sync concluÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¿ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â½do.");
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
      setToolsMsg(`Importado: linhas ${res?.processed_rows ?? "?"}, produtos ${res?.upserted_products ?? "?"}, versÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¿ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â½o db ${res?.new_db_version ?? "?"}`);
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

  async function runSetHeaderLogos() {
    try {
      const picked = await openDialog({ multiple: true, filters: [{ name: "Imagens", extensions: ["png", "jpg", "jpeg", "webp"] }] });
      if (!picked || (Array.isArray(picked) && picked.length === 0)) return;
      const listRaw = Array.isArray(picked) ? picked : [picked];
      const unique = [];
      for (const p of listRaw) {
        const clean = sanitizeStoredPath(p);
        if (clean) {
          const normalized = toHeaderLogoPath(clean);
          if (normalized && !unique.includes(normalized)) unique.push(normalized);
        }
      }
      let finalList = unique;
      try {
        const res = await setHeaderLogosApi(listRaw);
        const returned = res?.header_logos || res?.headerLogos || [];
        if (Array.isArray(returned) && returned.length) finalList = returned.map((r) => toHeaderLogoPath(r));
      } catch (_) {
        /* fallback to local-only */
      }
      setHeaderLogos(finalList);
      setToolsMsg(`Logos atualizadas (${finalList.length}).`);
    } catch (e) {
      setToolsMsg(`Falha ao aplicar logos: ${e}`);
    }
  }

  function handleHeaderLogoError(path) {
    setHeaderLogos((prev) => prev.filter((p) => p !== path));
  }

  function cycleLaunch(delta) {
    if (!launchImages.length) return;
    setLaunchState((s) => ({ ...s, open: true, index: (s.index + delta + launchImages.length) % launchImages.length }));
  }

  const headerBgStyle = bgPath
    ? { backgroundImage: `url(${toDisplaySrc(bgPath)})`, backgroundSize: "cover", backgroundPosition: "center", backgroundRepeat: "no-repeat" }
    : undefined;

  const displayLogos = headerLogos.filter(Boolean);

  if (!ready) {
    return (
      <main className="container" style={headerBgStyle} onContextMenu={(e) => e.preventDefault()}>
        Carregando...
      </main>
    );
  }

  return (
    <>
      <main
        className={`container ${blockAccess ? "app-blocked" : ""}`}
        style={headerBgStyle}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="appbar">
          <div className="appbar-logo">
            {logoPath ? (
              <a href="https://www.ipsbrasil.com.br" target="_blank" rel="noreferrer">
                <img className="logo brand-logo" src={toDisplaySrc(logoPath)} alt="Logo" />
              </a>
            ) : null}
          </div>
          <div className="appbar-title">
            <h1>Catalogo IPS</h1>
            {displayLogos.length ? (
              <div className="logo-strip" role="list">
                {displayLogos.map((src, idx) => (
                  <img
                    key={idx}
                    role="listitem"
                    className="logo-strip-item"
                    src={toDisplaySrc(src)}
                    alt={`Logo ${idx + 1}`}
                    onError={() => handleHeaderLogoError(src)}
                  />
                ))}
              </div>
            ) : null}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            {updateInfo && !updateDismissed && (
              <div className="update-banner">
                <span>
                  Nova versao disponivel: {updateInfo.availableVersion} (atual {appVersion})
                </span>
                <a
                  className="launch-button"
                  href={updateInfo.downloadUrl || FIXED_DOWNLOAD}
                  target="_blank"
                  rel="noreferrer"
                  style={{ textDecoration: "none", padding: "6px 10px" }}
                >
                  Baixar/Atualizar
                </a>
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
              <div className="tools-panel" style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, marginTop: 8, alignItems: "center" }}>
                <input placeholder="URL do manifest" value={manifestInput} onChange={(e) => setManifestInput(e.target.value)} />
                <button disabled={syncing || !manifestInput} onClick={() => runSync(manifestInput)}>
                  {syncing ? "Sincronizando..." : "Sincronizar"}
                </button>
                <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8 }}>
                  <button onClick={() => runIndex(manifestInput)} disabled={!manifestInput || syncing}>
                    Indexar imagens (manifest)
                  </button>
                  <button onClick={() => loadLaunches(true)} disabled={launchState.loading}>
                    Abrir lancamentos
                  </button>
                </div>
                <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button onClick={runImportExcel}>Importar Excel</button>
                  {excelPath ? <span style={{ fontSize: 12, color: "#555" }}>ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¿ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â½ltimo: {excelPath}</span> : null}
                  <button onClick={runExportDb}>Exportar DB</button>
                  {exportPath ? <span style={{ fontSize: 12, color: "#555" }}>ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¿ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â½ltimo: {exportPath}</span> : null}
                  <button onClick={() => runSetBranding("logo")}>Aplicar logo</button>
                  {logoInput ? <span style={{ fontSize: 12, color: "#555" }}>Atual: {logoInput}</span> : null}
                  <button onClick={() => runSetBranding("background")}>Aplicar fundo</button>
                  {bgInput ? <span style={{ fontSize: 12, color: "#555" }}>Atual: {bgInput}</span> : null}
                  <button onClick={runSetHeaderLogos}>Carregar logos (appbar)</button>
                  <button onClick={() => setHeaderLogos([])}>Limpar logos (appbar)</button>
                  {headerLogos.length ? <span style={{ fontSize: 12, color: "#555" }}>Ativas: {headerLogos.length}</span> : null}
                </div>
                {toolsMsg && <span style={{ gridColumn: "1 / -1", fontSize: 12, color: "#444" }}>{toolsMsg}</span>}
              </div>
            </details>
          </div>
        )}

        {isDev && (statusMsg || secondaryStatus || syncing) && (
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
              <div className={`chip ${!brandId ? "active" : ""}`} onClick={() => { setBrandId(""); setBrandName(""); setGroup(""); setMake(""); setVehicleId(""); loadGroupsFor(null, null); }}>
                Todos
              </div>
              {brands.map((b) => (
                <div
                  key={b.id}
                  className={`chip ${String(brandId) === String(b.id) ? "active" : ""}`}
                  onClick={() => {
                    if (String(brandId) === String(b.id)) {
                      setBrandId("");
                      setBrandName("");
                      setGroup("");
                      setMake("");
                      setVehicleId("");
                      loadGroupsFor(null, null);
                    } else {
                      setBrandId(b.id);
                      setBrandName(b.name || "");
                      setGroup("");
                      setMake("");
                      setVehicleId("");
                      loadGroupsFor(b.id, b.name);
                    }
                  }}
                >
                  <div className="chip-row">
                    <span>{b.name}</span>
                    {String(brandId) === String(b.id) ? <span className="chip-chevron">v</span> : null}
                  </div>
                  {String(brandId) === String(b.id) && groups.length ? (
                    <div className="chip-groups">
                      <button
                        type="button"
                        className={`chip-group-item ${!group ? "selected" : ""}`}
                        onClick={(e) => { e.stopPropagation(); setGroup(""); }}
                      >
                        Todos
                      </button>
                      {groups.map((g) => (
                        <button
                          type="button"
                          key={g}
                          className={`chip-group-item ${group === g ? "selected" : ""}`}
                          onClick={(e) => { e.stopPropagation(); setGroup(g); }}
                        >
                          {g}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </aside>

          <section className="panel">
            <div className="filters" style={{ flexWrap: "wrap" }}>
              <input className="filter-code" placeholder="Pesquisar por codigo ou veiculo (produto/OEM/Similar/Veiculo)" value={codeQuery} onChange={(e) => setCodeQuery(e.target.value)} />
              <select value={group} onChange={(e) => { setGroup(e.target.value); setVehicleId(""); }}>
                <option value="">Grupo (todos)</option>
                {groups.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
              <select value={make} onChange={(e) => { setMake(e.target.value); setVehicleId(""); }}>
                <option value="">Montadora (todas)</option>
                {makes.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
                <option value="">Veiculo (todos)</option>
                {Array.from(
                  new Map(
                    vehicles.map((v) => {
                      const label = vehicleLabel(v.name);
                      return [label, v.id];
                    })
                  ).entries()
                ).map(([label, id]) => (
                  <option key={id} value={id}>
                    {label}
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
                      </div>
                      {p.vehicles ? (
                        <div style={{ fontSize: 14, opacity: 0.9 }}>
                          <strong>Aplicacoes:</strong> {p.vehicles}
                        </div>
                      ) : null}
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
                    <div className="subtitle">Compativel com:</div>
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
              <img src={launchImages[launchState.index]} alt="lancamento" />
              <button className="launch-arrow" onClick={() => cycleLaunch(1)} aria-label="Proximo">
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
                <p className="auth-muted">Envie a ficha e Aguarde aprovação. Enquanto o status não for aprovado, o catálogo fica bloqueado.</p>
                <p className="auth-status">Status atual: {profile?.status || "pending"}</p>
              </div>
              <div className="auth-brand">Catálogo IPS</div>
            </div>

            {supabaseConfigured ? (
              <>
                <section className="auth-section">
                  <h3>Ficha de cadastro</h3>
                  <p className="auth-muted">Envie seus dados; o time aprova manualmente e libera o acesso.</p>

                  {sentOnce ? (
                    <div className="auth-wait">
                      <p><strong>Cadastro enviado.</strong> Aguarde aprovacao do time.</p>
                      <p className="auth-muted small">Se precisar corrigir algo, reabra a ficha e reenvie.</p>
                    </div>
                  ) : (
                    <form className="auth-grid" onSubmit={submitRegistration}>
                      <div className="auth-radio">
                        <label>
                          <input type="radio" name="personType" checked={form.person_type === "pj"} onChange={() => setForm((s) => ({ ...s, person_type: "pj" }))} /> Pessoa JurÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¿ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â½dica
                        </label>
                        <label>
                          <input type="radio" name="personType" checked={form.person_type === "pf"} onChange={() => setForm((s) => ({ ...s, person_type: "pf" }))} /> Pessoa FÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¿ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â½sica
                        </label>
                      </div>

                      <label className="auth-field wide">
                        Nome/Razao Social
                        <input value={form.full_name} onChange={(e) => setForm((s) => ({ ...s, full_name: e.target.value }))} placeholder="Nome completo ou razÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¿ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â½o social" />
                      </label>
                      <label className="auth-field wide">
                        CPF/CNPJ
                        <input value={form.cpf_cnpj} onChange={(e) => setForm((s) => ({ ...s, cpf_cnpj: e.target.value }))} placeholder="000.000.000-00" />
                      </label>

                      <label className="auth-field">
                        Pais
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
                        <span>Codigo do cadastro: {profile?.id || "aguardando.."}</span>
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









