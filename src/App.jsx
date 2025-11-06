import { useEffect, useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { initApp, fetchBrands, fetchVehicles, searchProducts, getProductDetails, syncFromManifest, importExcel, indexImages, fetchGroups, fetchVehiclesFiltered, fetchGroupsStats, indexImagesFromManifest, setBrandingImage } from "./lib/api";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";

function App() {
  const [ready, setReady] = useState(false);
  const [imagesDir, setImagesDir] = useState("");
  const [dbVersion, setDbVersion] = useState(0);
  const [brands, setBrands] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [groups, setGroups] = useState([]);
  const [group, setGroup] = useState("");
  const [codeQuery, setCodeQuery] = useState("");
  const [brandId, setBrandId] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(null);
  const [manifestUrl, setManifestUrl] = useState("");
  const [brandingLogoUrl, setBrandingLogoUrl] = useState("");
  const [brandingBgUrl, setBrandingBgUrl] = useState("");
  const [logoPath, setLogoPath] = useState(localStorage.getItem("ui.logoPath") || "");
  const [bgPath, setBgPath] = useState(localStorage.getItem("ui.bgPath") || "");
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const [imagesRoot, setImagesRoot] = useState("");
  const [importMsg, setImportMsg] = useState("");
  const isDev = import.meta.env.MODE !== "production";

  useEffect(() => {
    (async () => {
      const info = await initApp();
      setImagesDir(info.images_dir);
      setDbVersion(info.db_version);
      const [bs, vs] = await Promise.all([fetchBrands(), fetchVehicles()]);
      setBrands(bs);
      setVehicles(vs);
      // Auto-sync + auto-index se houver manifest salvo
      const savedManifest = localStorage.getItem("manifestUrl") || "";
      const defaultManifest = import.meta.env.VITE_DEFAULT_MANIFEST_URL || "";
      const manifestToUse = savedManifest || defaultManifest;
      if (manifestToUse) {
        setManifestUrl(manifestToUse);
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
      }
      setReady(true);
    })();
  }, []);

  // Carrega branding versionado do projeto (public/images/branding.json)
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

  useEffect(() => {
    (async () => {
      const gs = await fetchGroups(brandId ? Number(brandId) : null);
      setGroups(gs);
      const vs = await fetchVehiclesFiltered(brandId ? Number(brandId) : null, group || null);
      setVehicles(vs);
    })();
  }, [brandId, group]);

  // Busca automática com debounce quando filtros mudam
  useEffect(() => {
    const t = setTimeout(() => { doSearch(); }, 300);
    return () => clearTimeout(t);
  }, [brandId, group, vehicleId, codeQuery]);

  async function doSearch() {
    const mapped = {
      brand_id: brandId ? Number(brandId) : null,
      group: group || null,
      vehicle_id: vehicleId ? Number(vehicleId) : null,
      code_query: codeQuery || null,
      limit: 200,
    };
    const list = await searchProducts(mapped);
    setResults(list);
  }

  async function openDetails(id) { const d = await getProductDetails(id); setSelected(d); }

  const imageUrls = useMemo(() => (!selected ? [] : (selected.images || []).map((f) => convertFileSrc(`${imagesDir}/${f}`))), [selected, imagesDir]);
  const logoUrl = useMemo(() => (logoPath ? convertFileSrc(logoPath) : (brandingLogoUrl || "")), [logoPath, brandingLogoUrl]);
  const bgUrl = useMemo(() => (bgPath ? convertFileSrc(bgPath) : (brandingBgUrl || "")), [bgPath, brandingBgUrl]);

  async function runSync() {
    if (!manifestUrl) return; setSyncing(true);
    try {
      const res = await syncFromManifest(manifestUrl);
      setSyncMsg(`Banco atualizado: ${res.updated_db ? "sim" : "não"} | Imagens baixadas: ${res.downloaded_images} | versão: ${res.db_version}`);
      setDbVersion(res.db_version);
      localStorage.setItem("manifestUrl", manifestUrl);
      try {
        const r = await indexImagesFromManifest(manifestUrl);
        setImportMsg(`Index manifest: varridos ${r.scanned} | correspondidos ${r.matched} | inseridos ${r.inserted}`);
      } catch (e) {
        setImportMsg(`Falha ao indexar manifest: ${e}`);
      }
      await doSearch();
    }
    catch (e) { setSyncMsg(`Falha ao sincronizar: ${e}`); }
    finally { setSyncing(false); }
  }

  async function runImportExcel() {
    const selected = await open({ multiple: false, filters: [{ name: 'Excel', extensions: ['xlsx','xls'] }] });
    if (!selected || Array.isArray(selected)) return;
    setImportMsg(`Importando: ${selected}`);
    try {
      const res = await importExcel(selected);
      setImportMsg(`Linhas: ${res.processed_rows} | Produtos upsert: ${res.upserted_products} | vínculos veículo: ${res.linked_vehicles} | nova versão: ${res.new_db_version}`);
      setDbVersion(res.new_db_version);
      const [bs, gs, vs] = await Promise.all([
        fetchBrands(),
        fetchGroups(brandId ? Number(brandId) : null),
        fetchVehiclesFiltered(brandId ? Number(brandId) : null, group || null)
      ]);
      setBrands(bs); setGroups(gs); setVehicles(vs);
      await doSearch();
    }
    catch (e) { setImportMsg(`Falha ao importar: ${e}`); }
  }

  async function runIndexImages() {
    if (!imagesRoot) return; setImportMsg("Indexando imagens…");
    try { const res = await indexImages(imagesRoot); setImportMsg(`Imagens varridas: ${res.scanned} | correspondidas: ${res.matched} | inseridas: ${res.inserted}`); if (selected) await openDetails(selected.id); }
    catch (e) { setImportMsg(`Falha ao indexar imagens: ${e}`); }
  }

  if (!ready) return <main className="container" style={bgUrl ? { backgroundImage: `url(${bgUrl})`, backgroundSize: "cover", backgroundAttachment: "fixed", backgroundPosition: "center" } : undefined}>Carregando…</main>;

  return (
    <main className="container" style={bgUrl ? { backgroundImage: `url(${bgUrl})`, backgroundSize: "cover", backgroundAttachment: "fixed", backgroundPosition: "center" } : undefined}>
      <div className="appbar">
        <div>{logoUrl ? <img className="logo" src={logoUrl} alt="logo" onError={(e)=>{ e.currentTarget.style.display="none"; }} /> : null}</div>
        <h1>Catálogo IPS</h1>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ opacity: 0.9 }}>DB v{dbVersion}</span>
          {isDev && (<div className="tools">
            <details>
              <summary>Ferramentas</summary>
              <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, marginTop: 8 }}>
                <input placeholder="URL do manifest.json (Git/R2)" value={manifestUrl} onChange={(e) => setManifestUrl(e.target.value)} />
                <button disabled={syncing || !manifestUrl} onClick={runSync}>{syncing ? "Sincronizando…" : "Verificar atualizações"}</button>
                <button disabled={!manifestUrl} onClick={async()=>{ setImportMsg("Indexando via manifest…"); try { const r = await indexImagesFromManifest(manifestUrl); setImportMsg(`Index manifest: varridos ${r.scanned} | correspondidos ${r.matched} | inseridos ${r.inserted}`); } catch(e){ setImportMsg(`Falha ao indexar manifest: ${e}`);} }}>Indexar via manifest</button>
                <button onClick={runImportExcel}>Importar Excel</button>
                <button onClick={async()=>{ const p = await open({ multiple:false, filters:[{ name:"Imagens", extensions:["png","jpg","jpeg","webp"] }]}); if(!p || Array.isArray(p)) return; try { const res = await setBrandingImage("logo", p); localStorage.removeItem("ui.logoPath"); setLogoPath(""); if(res && res.logo) setBrandingLogoUrl(`/images/${res.logo}`); setImportMsg("Logo definida em public/images."); } catch(e){ setImportMsg("Falha ao definir logo: "+e); } }}>Definir logo…</button>
                <button onClick={async()=>{ const p = await open({ multiple:false, filters:[{ name:"Imagens", extensions:["png","jpg","jpeg","webp"] }]}); if(!p || Array.isArray(p)) return; try { const res = await setBrandingImage("bg", p); localStorage.removeItem("ui.bgPath"); setBgPath(""); if(res && res.background) setBrandingBgUrl(`/images/${res.background}`); setImportMsg("Fundo definido em public/images."); } catch(e){ setImportMsg("Falha ao definir fundo: "+e); } }}>Definir fundo…</button>
                <button onClick={()=>{ localStorage.removeItem("ui.logoPath"); setLogoPath(""); setImportMsg("Logo removida (usando branding do app)."); }}>Limpar logo</button>
                <button onClick={()=>{ localStorage.removeItem("ui.bgPath"); setBgPath(""); setImportMsg("Fundo removido (usando branding do app)."); }}>Limpar fundo</button>
                <input placeholder="Pasta raiz das imagens (local)" value={imagesRoot} onChange={(e) => setImagesRoot(e.target.value)} />
                <button onClick={runIndexImages}>Indexar Imagens</button>
                <button onClick={async ()=>{ const s = await fetchGroupsStats(); setImportMsg(`Grupos: ${s.distinct_groups} | Produtos c/ grupo: ${s.products_with_group}`); }}>Diagnóstico grupos</button>
              </div>
              {(syncMsg || importMsg) && <p style={{ marginTop: 6 }}>{syncMsg} {importMsg && (syncMsg ? " | " : null)} {importMsg}</p>}
            </details>
          </div>)}
        </div>
      </div>

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
          <div className="filters" style={{flexWrap:'wrap'}}>
            <input className="filter-code" placeholder="Pesquisar por código (produto/OEM/Similar)" value={codeQuery} onChange={(e)=>setCodeQuery(e.target.value)} />
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
                <div style={{display: 'flex', flexDirection: 'column', gap: 4, width: '100%'}}>
                  <div style={{display:'flex', gap:8, alignItems:'center'}}>
                    <span className="code">{p.code}</span>
                    <span className="desc">{p.description}</span>
                    <span className="brand">{p.brand}</span>
                  </div>
                  {p.vehicles && <div style={{fontSize: 12, opacity: 0.9}}>Aplicação: {p.vehicles}</div>}
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
                  <div className="subtitle">Compatível com:</div>
                  <div className="compat-list">{selected.application}</div>
                </div>
              )}
              <div className="sep" />
              {selected.details && (<div className="details-text">{selected.details}</div>)}
              <div className="grid">
                {imageUrls.map((u, i) => (<img key={i} src={u} alt="produto" className="thumb" />))}
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

export default App;

