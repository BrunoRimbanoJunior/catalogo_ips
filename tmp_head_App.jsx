import { useEffect, useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { initApp, fetchBrands, fetchVehicles, searchProducts, getProductDetails, syncFromManifest, importExcel, indexImages, fetchGroups, fetchVehiclesFiltered, fetchGroupsStats, indexImagesFromManifest } from "./lib/api";
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
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  // excelPath removido: usaremos seletor de arquivo do sistema
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
          // persiste a URL adotada
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

  useEffect(() => {
    (async () => {
      const gs = await fetchGroups(brandId ? Number(brandId) : null);
      setGroups(gs);
      const vs = await fetchVehiclesFiltered(brandId ? Number(brandId) : null, group || null);
      setVehicles(vs);
    })();
  }, [brandId, group]);

  // Busca autom+ítica com debounce quando filtros mudam
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

  async function runSync() {
    if (!manifestUrl) return; setSyncing(true);
    try { const res = await syncFromManifest(manifestUrl); setSyncMsg(`Banco atualizado: ${res.updated_db ? "sim" : "n+úo"} | Imagens baixadas: ${res.downloaded_images} | vers+úo: ${res.db_version}`); setDbVersion(res.db_version); localStorage.setItem("manifestUrl", manifestUrl); await doSearch(); }
    catch (e) { setSyncMsg(`Falha ao sincronizar: ${e}`); }
    finally { setSyncing(false); }
  }

  async function runImportExcel() {
    const selected = await open({ multiple: false, filters: [{ name: 'Excel', extensions: ['xlsx','xls'] }] });
    if (!selected || Array.isArray(selected)) return;
    setImportMsg(`Importando: ${selected}`);
    try {
      const res = await importExcel(selected);
      setImportMsg(`Linhas: ${res.processed_rows} | Produtos upsert: ${res.upserted_products} | v+¡nculos ve+¡culo: ${res.linked_vehicles} | nova vers+úo: ${res.new_db_version}`);
      setDbVersion(res.new_db_version);
      // Recarrega listas dependentes
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
    if (!imagesRoot) return; setImportMsg("Indexando imagensÔÇª");
    try { const res = await indexImages(imagesRoot); setImportMsg(`Imagens varridas: ${res.scanned} | correspondidas: ${res.matched} | inseridas: ${res.inserted}`); if (selected) await openDetails(selected.id); }
    catch (e) { setImportMsg(`Falha ao indexar imagens: ${e}`); }
  }

  if (!ready) return <main className="container">CarregandoÔÇª</main>;

  return (
    <main className="container">
      <div className="appbar row" style={{ alignItems: "center", gap: 12 }}>
        <h1>Cat+ílogo IPS</h1>
        <span style={{ opacity: 0.9 }}>DB v{dbVersion}</span>
        {isDev && (<div className="tools" style={{ marginLeft: "auto" }}>
          <details>
            <summary>Ferramentas</summary>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, marginTop: 8 }}>
              <input placeholder="URL do manifest.json (Git/OneDrive)" value={manifestUrl} onChange={(e) => setManifestUrl(e.target.value)} />
              <button disabled={syncing || !manifestUrl} onClick={runSync}>{syncing ? "SincronizandoÔÇª" : "Verificar atualiza+º+Áes"}</button>
              <button disabled={!manifestUrl} onClick={async()=>{ setImportMsg("Indexando via manifestÔÇª"); try { const r = await indexImagesFromManifest(manifestUrl); setImportMsg(`Index manifest: varridos ${r.scanned} | correspondidos ${r.matched} | inseridos ${r.inserted}`); } catch(e){ setImportMsg(`Falha ao indexar manifest: ${e}`);} }}>Indexar via manifest</button>
              <button onClick={runImportExcel}>Importar Excel</button>
              <input placeholder="Pasta raiz das imagens (OneDrive)" value={imagesRoot} onChange={(e) => setImagesRoot(e.target.value)} />
              <button onClick={runIndexImages}>Indexar Imagens</button>
              <button onClick={async ()=>{ const s = await fetchGroupsStats(); setImportMsg(`Grupos: ${s.distinct_groups} | Produtos c/ grupo: ${s.products_with_group}`); }}>Diagn+¦stico grupos</button>
            </div>
            {(syncMsg || importMsg) && <p style={{ marginTop: 6 }}>{syncMsg} {importMsg && (syncMsg ? " | " : null)} {importMsg}</p>}
          </details>
        </div>)}
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
            <input className="filter-code" placeholder="Pesquisar por c+¦digo (produto/OEM/Similar)" value={codeQuery} onChange={(e)=>setCodeQuery(e.target.value)} />
            <select value={group} onChange={(e) => { setGroup(e.target.value); setVehicleId(""); }}>
              <option value="">Grupo (todos)</option>
              {groups.map((t) => (<option key={t} value={t}>{t}</option>))}
            </select>
            <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
              <option value="">Ve+¡culo (todos)</option>
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
                  {p.vehicles && <div style={{fontSize: 12, opacity: 0.9}}>Aplica+º+úo: {p.vehicles}</div>}
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <h3 style={{ marginTop: 0 }}>Detalhes</h3>
          {!selected && <p>Selecione um produto</p>}
          {selected && (
            <div>
              <p>
                <b>{selected.code}</b> ÔÇö {selected.description}
                <br />
                <span style={{ opacity: 0.8 }}>Marca: {selected.brand}</span>
              </p>
              {selected.application && (<p><i>Aplica+º+úo:</i> {selected.application}</p>)}
              {selected.details && (<p><i>Detalhes:</i> {selected.details}</p>)}
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

