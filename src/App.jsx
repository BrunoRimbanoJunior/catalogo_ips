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
} from "./lib/api";
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
    if (mod && typeof mod.open === "function") {
      await mod.open(path);
      return true;
    }
  } catch (_) {}
  return false;
}

function App() {
  const isDev = import.meta.env.MODE !== "production";

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
            const res = await syncFromManifest(manifestToUse);
            setDbVersion(res.db_version);
            setSyncMsg(`Atualizado ao iniciar: db v${res.db_version} | imgs +${res.downloaded_images}`);
            localStorage.setItem("manifestUrl", manifestToUse);
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
      const gs = await fetchGroups(brandId ? Number(brandId) : null);
      setGroups(gs);
      const vs = await fetchVehiclesFiltered(brandId ? Number(brandId) : null, group || null);
      setVehicles(vs);
    })();
  }, [brandId, group]);

  // Debounce de busca
  useEffect(() => {
    const t = setTimeout(() => { doSearch(); }, 300);
    return () => clearTimeout(t);
  }, [brandId, group, vehicleId, codeQuery]);

  // Auto‑ocultar mensagens da barra de status
  useEffect(() => {
    if (syncing) return; // não fecha enquanto estiver rodando
    if (!syncMsg && !importMsg) return;
    const h = setTimeout(() => { setSyncMsg(""); setImportMsg(""); }, 6000);
    return () => clearTimeout(h);
  }, [syncMsg, importMsg, syncing]);

  async function doSearch() {
    const params = {
      brand_id: brandId ? Number(brandId) : null,
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
      const files = selected.images || [];
      try {
        const { readImageBase64 } = await import("./lib/api.js");
        const outs = [];
        for (const f of files) {
          const p = joinFsPath(imagesDir, f);
          try { outs.push(await readImageBase64(p)); }
          catch { outs.push(""); }
        }
        setImageUrls(outs.filter(Boolean));
      } catch {
        // fallback para asset:// caso invoke nÃ£o esteja disponÃ­vel
        const outs = files.map((f) => {
          const norm = normalizeFsPath(joinFsPath(imagesDir, f));
          const trimmed = norm.startsWith("/") ? norm.slice(1) : norm;
          return `asset://localhost/${trimmed}`;
        });
        setImageUrls(outs);
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
        fetchGroups(brandId ? Number(brandId) : null),
        fetchVehiclesFiltered(brandId ? Number(brandId) : null, group || null),
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

  if (!ready) {
    return (
      <main className="container" style={brandingBgUrl ? { backgroundImage: `url(${brandingBgUrl})`, backgroundSize: "cover", backgroundAttachment: "fixed", backgroundPosition: "center" } : undefined}>
        Carregandoâ€¦
      </main>
    );
  }

  return (
    <>
    <main className="container" style={brandingBgUrl ? { backgroundImage: `url(${brandingBgUrl})`, backgroundSize: "cover", backgroundAttachment: "fixed", backgroundPosition: "center" } : undefined}>
      <div className="appbar">
        <div>{brandingLogoUrl ? <img className="logo" src={brandingLogoUrl} alt="logo" onError={(e)=>{ e.currentTarget.style.display = "none"; }} /> : null}</div>
        <h1>Catálogo IPS</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ opacity: 0.9 }}>DB v{dbVersion}</span>
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
              {groups.map((t) => (<option key={t} value={t}>{t}</option>))}
            </select>
            <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
              <option value="">Veículo (todos)</option>
              {vehicles.map((v) => (<option key={v.id} value={v.id}>{v.name}</option>))}
            </select>
            <button onClick={doSearch}>Pesquisar</button>
          </div>
          <h3 style={{ marginTop: 0 }}>Resultados ({results.length})</h3>
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
    </>
  );
}

export default App;


