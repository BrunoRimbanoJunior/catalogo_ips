import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
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
  runRcloneSync,
  getAppVersionConfig,
  setAppVersionConfig,
  fetchGroups,
  fetchPrintCatalog,
  cleanupImagesFromManifest,
  exportPrintExcel,
  savePdfBase64,
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
import { supabase } from "./lib/supabaseClient";
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

const GITHUB_REPO = "BrunoRimbanoJunior/catalogo_ips";
const GITHUB_RELEASES_LATEST = `https://github.com/${GITHUB_REPO}/releases/latest`;
const GITHUB_LATEST_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

function onlyDigits(value = "") {
  return String(value || "").replace(/\D/g, "");
}

function hasRepeatedDigits(digits) {
  return /^(\d)\1+$/.test(digits);
}

function isValidCpf(value = "") {
  const digits = onlyDigits(value);
  if (digits.length !== 11 || hasRepeatedDigits(digits)) return false;

  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += Number(digits[i]) * (10 - i);
  let check = (sum * 10) % 11;
  if (check === 10) check = 0;
  if (check !== Number(digits[9])) return false;

  sum = 0;
  for (let i = 0; i < 10; i += 1) sum += Number(digits[i]) * (11 - i);
  check = (sum * 10) % 11;
  if (check === 10) check = 0;
  return check === Number(digits[10]);
}

function isValidCnpj(value = "") {
  const digits = onlyDigits(value);
  if (digits.length !== 14 || hasRepeatedDigits(digits)) return false;

  const calcDigit = (base, weights) => {
    const sum = weights.reduce((acc, weight, index) => acc + Number(base[index]) * weight, 0);
    const mod = sum % 11;
    return mod < 2 ? 0 : 11 - mod;
  };

  const first = calcDigit(digits, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = calcDigit(digits, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return first === Number(digits[12]) && second === Number(digits[13]);
}

function isValidRegistrationEmail(value = "") {
  const email = String(value || "").trim();
  if (!email || email.length > 254 || /\s/.test(email)) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function validateRegistrationForm(form, fallbackEmail = "") {
  const email = String(form.email || fallbackEmail || "").trim().toLowerCase();
  const cpfCnpj = String(form.cpf_cnpj || "").trim();
  const isCompany = form.person_type === "pj";

  if (!isValidRegistrationEmail(email)) {
    return { error: "Informe um e-mail valido." };
  }
  if (isCompany && !isValidCnpj(cpfCnpj)) {
    return { error: "Informe um CNPJ valido." };
  }
  if (!isCompany && !isValidCpf(cpfCnpj)) {
    return { error: "Informe um CPF valido." };
  }
  return { error: "", email, cpfCnpj };
}

function normalizeVersionTag(raw = "") {
  return String(raw || "").trim().replace(/^v/i, "");
}

async function fetchLatestRelease() {
  const res = await fetch(GITHUB_LATEST_API, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub latest release failed: ${res.status}`);
  const data = await res.json();
  const version = normalizeVersionTag(data?.tag_name || data?.name || "");
  const htmlUrl = data?.html_url || GITHUB_RELEASES_LATEST;
  const assets = Array.isArray(data?.assets)
    ? data.assets
        .map((asset) => ({
          name: asset?.name || "",
          url: asset?.browser_download_url || "",
        }))
        .filter((asset) => asset.name && asset.url)
    : [];
  return { version, htmlUrl, assets };
}

async function openExternal(path) {
  try {
    const opener = await import("@tauri-apps/plugin-opener");
    const isUrl = /^https?:\/\//i.test(String(path || ""));
    if (isUrl && opener?.openUrl) return opener.openUrl(path);
    if (!isUrl && opener?.openPath) return opener.openPath(path);
    if (opener?.openUrl) return opener.openUrl(path);
  } catch (_) {
    // fallback
  }
  window.open(path, "_blank");
  return undefined;
}

async function getPlatformInfo() {
  const ua = navigator?.userAgent || "";
  let platform = "unknown";
  if (/Windows/i.test(ua)) platform = "windows";
  else if (/Mac/i.test(ua)) platform = "macos";
  else if (/Linux/i.test(ua)) platform = "linux";

  let arch = null;
  if (/arm64|aarch64/i.test(ua)) arch = "arm64";
  if (/x86_64|win64|x64|amd64/i.test(ua)) arch = "x64";
  return { platform, arch };
}

function normalizeAssetName(name = "") {
  return String(name).toLowerCase();
}

function assetMatchesArch(name, arch) {
  if (!arch) return true;
  const n = normalizeAssetName(name);
  if (arch === "x86_64" || arch === "x64" || arch === "amd64") {
    return n.includes("x64") || n.includes("x86_64") || n.includes("amd64");
  }
  if (arch === "aarch64" || arch === "arm64") {
    return n.includes("arm64") || n.includes("aarch64");
  }
  return true;
}

function pickAssetForPlatform(assets, platform, arch) {
  if (!Array.isArray(assets) || assets.length === 0) return null;
  const scored = assets
    .map((asset) => {
      const name = normalizeAssetName(asset.name);
      let score = 0;
      if (platform === "windows") {
        if (name.endsWith("-setup.exe")) score += 40;
        if (name.endsWith(".msi")) score += 30;
        if (name.endsWith(".exe")) score += 20;
      } else if (platform === "macos") {
        if (name.endsWith(".dmg")) score += 40;
        if (name.endsWith(".app.tar.gz")) score += 30;
        if (name.endsWith(".app.zip")) score += 20;
      } else if (platform === "linux") {
        if (name.endsWith(".appimage")) score += 40;
        if (name.endsWith(".deb")) score += 30;
        if (name.endsWith(".rpm")) score += 20;
      }
      if (assetMatchesArch(name, arch)) score += 10;
      return { asset, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.asset?.url || null;
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

// Label curto: apenas a primeira "palavra" (antes de espaço ou /) para agrupar nomes iguais.
function vehicleLabel(name = "") {
  const first = String(name)
    .split(/[\/\s]+/)
    .map((s) => s.trim())
    .find(Boolean);
  return first || name || "";
}

function optionKey(value = "") {
  return String(value || "").trim().toUpperCase();
}

function sortOptions(a, b) {
  return String(a.label || "").localeCompare(String(b.label || ""), "pt-BR", { numeric: true, sensitivity: "base" });
}

function lineDisplayLabel(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.replace(/^LINHA\s+/i, "").toUpperCase();
}

function uniqueTextOptions(values = [], labelFormatter = null) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const clean = String(value || "").trim();
    if (!clean) continue;
    const key = optionKey(clean);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ value: clean, label: labelFormatter ? labelFormatter(clean) : clean });
  }
  return out.sort(sortOptions);
}

function vehiclePrintOptions(list = [], search = "", selectedLines = []) {
  const query = String(search || "").trim().toUpperCase();
  const lineSet = new Set((selectedLines || []).map(optionKey).filter(Boolean));
  const seen = new Set();
  const out = [];
  for (const vehicle of list || []) {
    const rawCategory = vehicle?.category || "";
    if (lineSet.size && !lineSet.has(optionKey(rawCategory))) continue;
    const label = vehicleLabel(vehicle?.name || "");
    if (!label) continue;
    const key = optionKey(label);
    if (seen.has(key)) continue;
    if (query && !key.includes(query)) continue;
    seen.add(key);
    out.push({ value: label, label });
  }
  return out.sort(sortOptions);
}

function PrintFilterList({ title, options, selected, onToggle, onClear, emptyText, children }) {
  const selectedSet = new Set(selected || []);
  const selectedCount = selectedSet.size;
  return (
    <section className="print-filter-block">
      <div className="print-filter-heading">
        <span>{title}</span>
        <em>(Selecionados: {selectedCount})</em>
      </div>
      {children}
      <div className="print-options" role="group" aria-label={title}>
        <label className={`print-option ${selectedCount === 0 ? "selected" : ""}`}>
          <input type="checkbox" checked={selectedCount === 0} onChange={onClear} />
          <span>TODOS</span>
        </label>
        {options.length === 0 ? <div className="print-empty">{emptyText || "Nenhum item encontrado."}</div> : null}
        {options.map((opt) => (
          <label key={opt.value} className={`print-option ${selectedSet.has(opt.value) ? "selected" : ""}`}>
            <input type="checkbox" checked={selectedSet.has(opt.value)} onChange={() => onToggle(opt.value)} />
            <span>{opt.label}</span>
          </label>
        ))}
      </div>
    </section>
  );
}

function escapeHtml(value = "") {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function displayText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function firstCatalogVehicle(value = "") {
  return (
    String(value || "")
      .split(/[;,\|\n\r]+/)
      .map((part) => part.trim())
      .find(Boolean) || ""
  );
}

async function loadLocalImageSrc(path = "") {
  if (!path) return "";
  return await readImageBase64(path);
}

function chunkArray(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function yieldToUi() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function catalogPrintTitle(filters) {
  const groups = filters?.groups || [];
  return groups.length === 1 ? displayText(groups[0], "CATALOGO DE PRODUTOS").toUpperCase() : "CATALOGO DE PRODUTOS";
}

function catalogIndexLineTitle(filters) {
  const lines = filters?.lines || [];
  return lines.length === 1 ? displayText(lines[0], "").toUpperCase() : "CATALOGO DE PRODUTOS";
}

function buildPrintCatalogHtml({ items, filters }) {
  const itemsPerPage = 6;
  const indexEntriesPerPage = 28;
  const sortedItems = [...items].sort((a, b) => {
    const ak = [a.group, a.make, a.vehicle, a.description, a.code].map((v) => String(v || "").toUpperCase()).join("|");
    const bk = [b.group, b.make, b.vehicle, b.description, b.code].map((v) => String(v || "").toUpperCase()).join("|");
    return ak.localeCompare(bk, "pt-BR", { numeric: true, sensitivity: "base" });
  });

  const groupMap = new Map();
  sortedItems.forEach((item, index) => {
    const group = displayText(item.group, "SEM GRUPO").toUpperCase();
    const make = displayText(item.make, "SEM MONTADORA").toUpperCase();
    const key = `${group}||${make}`;
    if (!groupMap.has(key)) groupMap.set(key, { group, make, firstIndex: index, total: 0 });
    groupMap.get(key).total += 1;
  });
  const groupListBase = Array.from(groupMap.values());
  const indexGroupCount = new Set(groupListBase.map((entry) => entry.group)).size;
  const indexPageCount = Math.max(1, Math.ceil((groupListBase.length + indexGroupCount) / indexEntriesPerPage));
  const firstProductPage = 3 + indexPageCount;
  const indexGroups = groupListBase.map((entry) => ({
    ...entry,
    page: firstProductPage + Math.floor(entry.firstIndex / itemsPerPage),
  }));
  const productPages = chunkArray(sortedItems, itemsPerPage);
  const coverTitle = catalogPrintTitle(filters);
  const indexLineTitle = catalogIndexLineTitle(filters);
  const indexRows = [];
  let lastIndexGroup = "";
  indexGroups.forEach((entry) => {
    if (entry.group !== lastIndexGroup) {
      indexRows.push({ type: "group", group: entry.group });
      lastIndexGroup = entry.group;
    }
    indexRows.push({ type: "make", make: entry.make, page: entry.page });
  });

  const indexPages = chunkArray(indexRows, indexEntriesPerPage)
    .map((entries, pageOffset) => {
      const rows = entries
        .map((entry) =>
          entry.type === "group"
            ? `<div class="index-group-title">${escapeHtml(entry.group)}</div>`
            : `
            <div class="index-row">
              <span class="index-sub">${escapeHtml(entry.make)}</span>
              <span class="index-dots"></span>
              <span class="index-page">${entry.page}</span>
            </div>`
        )
        .join("");
      return `
        <section class="page index-page-wrap">
          <header class="catalog-header index-header">
            <div class="header-brand">IPS DO BRASIL</div>
            <div class="index-header-copy">
              <strong>${escapeHtml(indexLineTitle)}</strong>
              <span>CATALOGO 2026</span>
            </div>
          </header>
          <main class="index-content">
            <h1>Indice:</h1>
            <div class="index-list">${rows || '<div class="index-empty">Nenhum item selecionado.</div>'}</div>
          </main>
          <footer class="catalog-footer">
            <span>${3 + pageOffset}</span>
            <strong>www.ipsbrasil.com.br</strong>
          </footer>
        </section>`;
    })
    .join("");

  const productHtml = productPages
    .map((pageItems, pageIndex) => {
      const pageNo = firstProductPage + pageIndex;
      const pageIsEven = pageNo % 2 === 0;
      const cards = pageItems
        .map((item) => {
          const make = displayText(item.make, item.brand).toUpperCase();
          const vehicle = displayText(firstCatalogVehicle(item.vehicle), "APLICACAO").toUpperCase();
          const description = displayText(item.description, "PRODUTO").toUpperCase();
          const image = item.imageSrc
            ? `<img src="${escapeHtml(item.imageSrc)}" alt="">`
            : `<div class="no-image">IMAGEM<br>INDISPONIVEL</div>`;
          return `
            <article class="product-card">
              <div class="card-top">
                <div class="card-vehicle"><strong>${escapeHtml(make)}</strong><span>// ${escapeHtml(vehicle)}</span></div>
                <span class="card-code">${escapeHtml(item.code)}</span>
              </div>
              <div class="card-image">${image}</div>
              <div class="card-desc">${escapeHtml(description)}</div>
              <div class="card-application">${escapeHtml(vehicle)}</div>
            </article>`;
        })
        .join("");
      const footerPage = `<span class="footer-page-no">${pageNo}</span>`;
      const footerBody = `
            <div>
              <strong>www.ipsbrasil.com.br</strong>
              <small>AS FOTOS CONTIDAS NESSE CATALOGO SAO DE CARATER MERAMENTE ILUSTRATIVO, NAO CORRESPONDENDO A FOTO ORIGINAL DO PRODUTO. AS MARCAS DAS MONTADORAS SAO DE FUNCAO MERAMENTE INFORMATIVAS E COMPARATIVAS.</small>
            </div>`;
      const footerLogo = `<img class="footer-logo" src="/images/logo.png" alt="">`;
      return `
        <section class="page product-page">
          <header class="catalog-header product-header">
            <div class="header-red">
              <img src="/images/logo.png" alt="">
            </div>
            <div class="header-copy">
              <strong>${escapeHtml(coverTitle)}</strong>
              <span>IPS DO BRASIL</span>
              <small>CATALOGO 2026</small>
            </div>
          </header>
          <main class="product-grid">${cards}</main>
          <footer class="catalog-footer product-footer ${pageIsEven ? "footer-even" : "footer-odd"}">
            ${pageIsEven ? `${footerLogo}${footerBody}${footerPage}` : `${footerPage}${footerBody}${footerLogo}`}
          </footer>
        </section>`;
    })
    .join("");

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8">
      <title>Catalogo IPS - Impressao</title>
      <style>
        @page { size: A4 portrait; margin: 0; }
        * { box-sizing: border-box; }
        body { margin: 0; background: #d9d9d9; color: #111; font-family: Arial, Helvetica, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        .page { position: relative; width: 210mm; height: 297mm; overflow: hidden; background: #fff; page-break-after: always; break-after: page; }
        .cover-bg, .back-bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
        .cover-title { position: absolute; left: 17mm; right: 17mm; top: 118mm; text-align: center; color: #f50812; font-size: 28pt; line-height: 1.12; font-weight: 900; letter-spacing: 1px; text-shadow: -1.3px -1.3px #fff, 1.3px -1.3px #fff, -1.3px 1.3px #fff, 1.3px 1.3px #fff, 0 4px 8px rgba(0,0,0,.45); }
        .cover-year { position: absolute; right: 24mm; bottom: 68mm; color: #fff; font-size: 20pt; font-weight: 900; text-shadow: 0 3px 8px rgba(0,0,0,.6); }
        .catalog-header { min-height: 32mm; display: grid; grid-template-columns: 1fr minmax(0, 1.15fr) auto; align-items: center; gap: 8mm; padding: 7mm 10mm 4mm; background: linear-gradient(110deg, #e60018 0 45%, #f7f7f7 45% 100%); border-bottom: 1px solid #ddd; }
        .catalog-header .header-brand { color: #fff; font-size: 22pt; font-weight: 900; font-style: italic; white-space: normal; word-wrap: break-word; overflow-wrap: break-word; }
        .catalog-header .header-title { color: #e60018; font-size: 18pt; font-weight: 900; font-style: italic; white-space: normal; overflow-wrap: break-word; word-wrap: break-word; text-align: center; }
        .catalog-header .header-year { color: #111; font-size: 14pt; font-weight: 900; }
        .index-header { min-height: 30mm; grid-template-columns: minmax(0, 45%) minmax(0, 1fr); gap: 6mm; padding: 7mm 10mm 4mm; background: linear-gradient(110deg, #e60018 0 45%, #f7f7f7 45% 100%); align-items: center; }
        .index-header .header-brand { min-width: 0; color: #fff; font-size: 18pt; line-height: 1.2; white-space: normal; overflow-wrap: break-word; word-wrap: break-word; }
        .index-header-copy { min-width: 0; text-align: right; line-height: 1.15; }
        .index-header-copy strong { display: block; color: #e60018; font-size: 17pt; font-style: italic; font-weight: 900; white-space: normal; overflow-wrap: break-word; word-wrap: break-word; }
        .index-header-copy span { display: block; margin-top: 3mm; color: #111; font-size: 14pt; font-weight: 900; white-space: nowrap; }
        .index-content { padding: 8mm 13mm 12mm; min-height: calc(297mm - 30mm - 16mm - 8mm); display: flex; flex-direction: column; justify-content: space-between; }
        .index-content h1 { margin: 0; color: #c62828; font-size: 24pt; text-transform: uppercase; }
        .index-content p { margin: 2mm 0 7mm; font-size: 10pt; color: #555; }
        .index-list { display: flex; flex-direction: column; gap: 2.2mm; margin-top: 5mm; }
        .index-group-title { margin-top: 2mm; color: #c62828; font-size: 12pt; line-height: 1.15; font-weight: 900; text-transform: uppercase; }
        .index-row { display: grid; grid-template-columns: auto 1fr auto; gap: 3mm; align-items: baseline; font-size: 11pt; padding-left: 5mm; }
        .index-sub { font-weight: 800; }
        .index-dots { border-bottom: 1px dotted #999; transform: translateY(-1.5mm); }
        .index-page { font-weight: 900; }
        .index-empty { padding: 10mm; color: #777; border: 1px solid #ddd; }
        .product-header { grid-template-columns: 1fr 1fr; padding: 0; background: #f5f5f5; min-height: 30mm; }
        .header-red { height: 100%; background: #e60018; clip-path: polygon(0 0, 93% 0, 84% 100%, 0 100%); display: flex; align-items: center; padding-left: 12mm; }
        .header-red img { max-width: 58mm; max-height: 20mm; object-fit: contain; filter: brightness(0) invert(1); }
        .header-copy { text-align: center; padding-right: 8mm; line-height: 1.15; display: flex; flex-direction: column; justify-content: center; }
        .header-copy strong { display: block; color: #e60018; font-size: 18pt; font-style: italic; font-weight: 900; white-space: normal; overflow-wrap: break-word; }
        .header-copy span { display: block; color: #111; font-size: 16pt; font-style: italic; font-weight: 900; white-space: normal; overflow-wrap: break-word; }
        .header-copy small { display: block; color: #111; font-size: 12pt; font-style: italic; font-weight: 900; white-space: normal; overflow-wrap: break-word; }
        .product-grid { height: calc(297mm - 30mm - 24mm - 6mm); padding: 4mm 10mm 3mm; display: grid; grid-template-columns: repeat(2, 1fr); grid-template-rows: repeat(3, 1fr); gap: 3mm; }
        .product-card { position: relative; overflow: hidden; border: 1px solid #d3d3d3; background: #fff; display: grid; grid-template-rows: 10mm 1fr auto auto; }
        .product-card::before { content: ""; position: absolute; inset: 10mm 0 24mm; background: radial-gradient(circle at 75% 0%, rgba(0,0,0,.08), transparent 45%), linear-gradient(135deg, transparent 0 67%, rgba(0,0,0,.07) 67% 70%, transparent 70%); pointer-events: none; }
        .card-top { position: relative; z-index: 1; height: 10mm; background: #d4d4d4; display: flex; align-items: center; padding: 0 4mm; border-bottom: 1px solid #aaa; }
        .card-vehicle { width: 100%; min-width: 0; font-size: 10pt; font-weight: 900; font-style: italic; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .card-vehicle strong { color: #ef2630; margin-right: 2mm; }
        .card-vehicle span { color: #111; }
        .card-code { position: absolute; left: 1mm; top: 1mm; width: 1px; height: 1px; overflow: hidden; opacity: 0.01; color: transparent; font-size: 1pt; line-height: 1; pointer-events: none; }
        .card-image { position: relative; z-index: 1; display: flex; align-items: center; justify-content: center; padding: 2mm 4mm; min-height: 0; overflow: hidden; }
        .card-image img { width: 100%; height: 100%; max-width: 100%; max-height: 100%; object-fit: contain; object-position: center; }
        .no-image { color: #aaa; border: 1px dashed #ccc; padding: 7mm 10mm; text-align: center; font-size: 10pt; font-weight: 800; }
        .card-desc { position: relative; z-index: 1; border-top: 1px solid #ddd; padding: 2.5mm 3mm 1mm; min-height: 12mm; text-align: center; font-size: 9.8pt; line-height: 1.13; white-space: normal; overflow-wrap: anywhere; word-break: break-word; }
        .card-application { position: relative; z-index: 1; padding: 0 3mm 2.5mm; text-align: center; font-size: 9.8pt; line-height: 1.13; font-weight: 900; white-space: normal; overflow-wrap: anywhere; word-break: break-word; }
        .catalog-footer { position: absolute; left: 0; right: 0; bottom: 0; min-height: 24mm; background: #a00012; color: #fff; display: grid; grid-template-columns: 20mm 1fr 34mm; align-items: center; gap: 5mm; padding: 6mm 10mm; }
        .catalog-footer span { font-size: 13pt; font-weight: 900; }
        .catalog-footer strong { display: block; text-align: center; font-size: 13pt; white-space: normal; overflow-wrap: break-word; }
        .catalog-footer small { display: block; margin-top: 2mm; text-align: center; font-size: 5.8pt; line-height: 1.5; font-style: italic; font-weight: 700; white-space: normal; overflow-wrap: break-word; }
        .catalog-footer img { max-width: 30mm; max-height: 13mm; object-fit: contain; filter: brightness(0) invert(1); }
        .product-footer { grid-template-columns: 34mm 1fr 34mm; }
        .product-footer .footer-page-no { justify-self: start; }
        .product-footer.footer-even .footer-page-no { justify-self: end; }
        .product-footer .footer-logo { justify-self: end; }
        .product-footer.footer-even .footer-logo { justify-self: start; }
        .index-page-wrap .catalog-footer { grid-template-columns: 20mm 1fr; min-height: 16mm; padding: 4mm 10mm; }
        @media screen { .page { margin: 0 auto 12px; box-shadow: 0 6px 22px rgba(0,0,0,.25); } }
      </style>
    </head>
    <body>
      <section class="page cover-page">
        <img class="cover-bg" src="/images/capa.png" alt="">
        <div class="cover-title">${escapeHtml(coverTitle)}</div>
        <div class="cover-year">CATALOGO 2026</div>
      </section>
      <section class="page back-cover-page">
        <img class="back-bg" src="/images/contra_capa.png" alt="">
      </section>
      ${indexPages}
      ${productHtml}
    </body>
  </html>`;
}

let activePrintRoot = null;
let activePrintStyle = null;
let activePrintObjectUrls = [];

function cleanupActivePrintDocument() {
  if (activePrintRoot) {
    activePrintRoot.remove();
    activePrintRoot = null;
  }
  if (activePrintStyle) {
    activePrintStyle.remove();
    activePrintStyle = null;
  }
  activePrintObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  activePrintObjectUrls = [];
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", cleanupActivePrintDocument);
}

function printHtmlDocument(html, objectUrls = []) {
  cleanupActivePrintDocument();

  const parsed = new DOMParser().parseFromString(html, "text/html");
  const styleText = Array.from(parsed.querySelectorAll("style"))
    .map((style) => style.textContent || "")
    .join("\n");
  const root = document.createElement("div");
  root.id = "catalog-print-root";
  root.innerHTML = parsed.body?.innerHTML || "";

  const style = document.createElement("style");
  style.id = "catalog-print-style";
  style.textContent = `
    ${styleText}
    @media screen {
      #catalog-print-root {
        position: fixed !important;
        left: -100000px !important;
        top: 0 !important;
        width: 210mm !important;
        min-height: 297mm !important;
        overflow: hidden !important;
        opacity: 0 !important;
        pointer-events: none !important;
      }
    }
    @media print {
      body > *:not(#catalog-print-root) {
        display: none !important;
      }
      #catalog-print-root {
        display: block !important;
        position: static !important;
        width: 210mm !important;
        min-height: 297mm !important;
        opacity: 1 !important;
        overflow: visible !important;
        pointer-events: auto !important;
      }
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(root);
  activePrintRoot = root;
  activePrintStyle = style;
  activePrintObjectUrls = objectUrls;

  let printed = false;
  const runPrint = () => {
    if (printed) return;
    printed = true;
    window.focus();
    window.print();
  };

  setTimeout(() => {
    const images = Array.from(root.querySelectorAll("img"));
    if (!images.length) {
      runPrint();
      return;
    }
    let pending = images.length;
    const done = () => {
      pending -= 1;
      if (pending <= 0) runPrint();
    };
    images.forEach((img) => {
      if (img.complete) {
        done();
      } else {
        img.onload = done;
        img.onerror = done;
      }
    });
    setTimeout(runPrint, 5000);
  }, 250);
}

const PDF_PAGE = { width: 595.28, height: 841.89 };
const PDF_MAX_ITEMS_PER_FILE = 360;
const PDF_RED = rgb(0.9, 0, 0.08);
const PDF_DARK_RED = rgb(0.62, 0, 0.07);
const PDF_BLACK = rgb(0.04, 0.04, 0.04);
const PDF_GRAY = rgb(0.82, 0.82, 0.82);
const PDF_LIGHT = rgb(0.96, 0.96, 0.96);
const PDF_BORDER = rgb(0.78, 0.78, 0.78);

function mm(value) {
  return value * 2.8346456693;
}

function cleanPdfText(value = "") {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7E\u00A0-\u00FF]/g, "")
    .trim();
}

function textWidth(font, text, size) {
  try {
    return font.widthOfTextAtSize(cleanPdfText(text), size);
  } catch (_) {
    return font.widthOfTextAtSize(cleanPdfText(text).replace(/[^\x20-\x7E]/g, ""), size);
  }
}

function drawPdfText(page, text, options) {
  try {
    page.drawText(cleanPdfText(text), options);
  } catch (_) {
    page.drawText(cleanPdfText(text).replace(/[^\x20-\x7E]/g, ""), options);
  }
}

function fitPdfText(text, font, size, maxWidth) {
  const clean = cleanPdfText(text);
  if (!clean || textWidth(font, clean, size) <= maxWidth) return clean;
  const suffix = "...";
  let out = clean;
  while (out.length > 1 && textWidth(font, `${out}${suffix}`, size) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out.trimEnd()}${suffix}`;
}

function wrapPdfText(text, font, size, maxWidth, maxLines = 3) {
  const words = cleanPdfText(text).split(" ").filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (textWidth(font, test, size) <= maxWidth) {
      current = test;
      continue;
    }
    if (current) lines.push(current);
    current = word;
    while (textWidth(font, current, size) > maxWidth && current.length > 1) {
      let part = current;
      while (part.length > 1 && textWidth(font, part, size) > maxWidth) part = part.slice(0, -1);
      lines.push(part);
      current = current.slice(part.length);
      if (lines.length >= maxLines) break;
    }
    if (lines.length >= maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length > maxLines) lines.length = maxLines;
  if (words.length && lines.length === maxLines) {
    const joined = lines.join(" ");
    if (joined.length < cleanPdfText(text).length) {
      lines[maxLines - 1] = fitPdfText(lines[maxLines - 1], font, size, maxWidth);
    }
  }
  return lines;
}

function similarCodesText(value = "") {
  return cleanPdfText(value)
    .replace(/\b[A-Z0-9À-Ý][A-Z0-9À-Ý .\/-]{1,24}:\s*/gi, " ")
    .replace(/[;,|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function drawCenteredPdfLines(page, lines, font, size, centerX, topY, maxWidth, color, lineHeight = size * 1.18) {
  lines.forEach((line, idx) => {
    const fitted = fitPdfText(line, font, size, maxWidth);
    drawPdfText(page, fitted, {
      x: centerX - textWidth(font, fitted, size) / 2,
      y: topY - idx * lineHeight,
      size,
      font,
      color,
    });
  });
}

function dataUrlToBytes(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;]+);base64,(.*)$/);
  if (!match) return null;
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return { bytes, mime: match[1] };
}

function guessPdfImageMime(bytes, fallback = "") {
  if (bytes?.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes?.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return fallback || "";
}

function isLocalImageSource(source = "") {
  const text = String(source || "");
  return /^[a-zA-Z]:[\\/]/.test(text) || text.startsWith("\\\\") || text.startsWith("/");
}

function isBundledImageAsset(source = "") {
  return /^\/images\//i.test(String(source || ""));
}

async function sourceToImageBytes(source) {
  if (!source) return null;
  const text = String(source);
  if (text.startsWith("data:")) return dataUrlToBytes(text);
  if (isBundledImageAsset(text)) {
    try {
      const response = await fetch(text);
      if (response.ok) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        return { bytes, mime: guessPdfImageMime(bytes, response.headers.get("content-type") || "") };
      }
    } catch (_) {
      // fallback to native image reader below
    }
  }
  if (isLocalImageSource(text)) {
    return dataUrlToBytes(await readImageBase64(text));
  }
  try {
    const response = await fetch(text);
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { bytes, mime: guessPdfImageMime(bytes, response.headers.get("content-type") || "") };
  } catch (_) {
    try {
      return dataUrlToBytes(await readImageBase64(text));
    } catch (_) {
      return null;
    }
  }
}

async function downsampleImageForPdf(loaded, options = {}) {
  const { maxWidth = 1100, maxHeight = 700, jpegQuality = 0.84 } = options;
  if (!loaded?.bytes?.length || typeof createImageBitmap !== "function") return loaded;

  const mime = guessPdfImageMime(loaded.bytes, loaded.mime).toLowerCase();
  if (!mime.startsWith("image/")) return loaded;

  let bitmap = null;
  try {
    const sourceBlob = new Blob([loaded.bytes], { type: mime || "image/png" });
    bitmap = await createImageBitmap(sourceBlob);
    const scale = Math.min(1, maxWidth / bitmap.width, maxHeight / bitmap.height);
    const shouldResize = scale < 1;
    const shouldConvert = !mime.includes("jpeg") && !mime.includes("jpg");
    const shouldCompress = loaded.bytes.length > 450_000;
    if (!shouldResize && !shouldConvert && !shouldCompress) return loaded;

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return loaded;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", jpegQuality));
    canvas.width = 1;
    canvas.height = 1;
    if (!blob || blob.size === 0) return loaded;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: "image/jpeg" };
  } catch (_) {
    return loaded;
  } finally {
    if (bitmap?.close) bitmap.close();
  }
}

async function embedPdfImage(pdfDoc, source, options = {}) {
  try {
    let loaded = await sourceToImageBytes(source);
    if (!loaded?.bytes?.length) return null;
    if (options.downsample) loaded = await downsampleImageForPdf(loaded, options);
    const mime = guessPdfImageMime(loaded.bytes, loaded.mime).toLowerCase();
    if (mime.includes("png")) return await pdfDoc.embedPng(loaded.bytes);
    if (mime.includes("jpeg") || mime.includes("jpg")) return await pdfDoc.embedJpg(loaded.bytes);
    return null;
  } catch (_) {
    return null;
  }
}

function drawImageContain(page, image, x, y, width, height) {
  if (!image) return;
  const scale = Math.min(width / image.width, height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  page.drawImage(image, {
    x: x + (width - drawWidth) / 2,
    y: y + (height - drawHeight) / 2,
    width: drawWidth,
    height: drawHeight,
  });
}

function drawImageCover(page, image, x, y, width, height) {
  if (!image) return;
  const scale = Math.max(width / image.width, height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  page.drawImage(image, {
    x: x + (width - drawWidth) / 2,
    y: y + (height - drawHeight) / 2,
    width: drawWidth,
    height: drawHeight,
  });
}

function sortCatalogItems(items = []) {
  return [...items].sort((a, b) => {
    const ak = [a.group, a.make, a.vehicle, a.description, a.code].map((v) => String(v || "").toUpperCase()).join("|");
    const bk = [b.group, b.make, b.vehicle, b.description, b.code].map((v) => String(v || "").toUpperCase()).join("|");
    return ak.localeCompare(bk, "pt-BR", { numeric: true, sensitivity: "base" });
  });
}

function buildCatalogPdfModel(items, filters) {
  const itemsPerPage = 6;
  const indexEntriesPerPage = 28;
  const sortedItems = sortCatalogItems(items);
  const groupMap = new Map();
  sortedItems.forEach((item, index) => {
    const group = displayText(item.group, "SEM GRUPO").toUpperCase();
    const make = displayText(item.make, "SEM MONTADORA").toUpperCase();
    const key = `${group}||${make}`;
    if (!groupMap.has(key)) groupMap.set(key, { group, make, firstIndex: index });
  });
  const groupList = Array.from(groupMap.values());
  const indexGroupCount = new Set(groupList.map((entry) => entry.group)).size;
  const indexPageCount = Math.max(1, Math.ceil((groupList.length + indexGroupCount) / indexEntriesPerPage));
  const firstProductPage = 3 + indexPageCount;
  const indexRows = [];
  let lastGroup = "";
  groupList.forEach((entry) => {
    if (entry.group !== lastGroup) {
      indexRows.push({ type: "group", group: entry.group });
      lastGroup = entry.group;
    }
    indexRows.push({ type: "make", make: entry.make, page: firstProductPage + Math.floor(entry.firstIndex / itemsPerPage) });
  });
  return {
    coverTitle: catalogPrintTitle(filters),
    indexLineTitle: catalogIndexLineTitle(filters),
    indexPages: chunkArray(indexRows, indexEntriesPerPage),
    productPages: chunkArray(sortedItems, itemsPerPage),
    firstProductPage,
  };
}

function drawPdfIndexHeader(page, fonts, title) {
  const headerH = mm(28);
  const y = PDF_PAGE.height - headerH;
  page.drawRectangle({ x: 0, y, width: PDF_PAGE.width * 0.45, height: headerH, color: PDF_RED });
  page.drawRectangle({ x: PDF_PAGE.width * 0.45, y, width: PDF_PAGE.width * 0.55, height: headerH, color: PDF_LIGHT });
  drawPdfText(page, "IPS DO BRASIL", { x: mm(10), y: y + mm(10), size: 20, font: fonts.boldOblique, color: rgb(1, 1, 1) });
  const fitted = fitPdfText(title, fonts.boldOblique, 18, PDF_PAGE.width * 0.45);
  drawPdfText(page, fitted, {
    x: PDF_PAGE.width - mm(10) - textWidth(fonts.boldOblique, fitted, 18),
    y: y + mm(16),
    size: 18,
    font: fonts.boldOblique,
    color: PDF_RED,
  });
  drawPdfText(page, "CATALOGO 2026", {
    x: PDF_PAGE.width - mm(10) - textWidth(fonts.bold, "CATALOGO 2026", 15),
    y: y + mm(6),
    size: 15,
    font: fonts.bold,
    color: PDF_BLACK,
  });
}

function drawPdfIndexPage(page, fonts, entries, pageNo, title) {
  drawPdfIndexHeader(page, fonts, title);
  let y = PDF_PAGE.height - mm(55);
  drawPdfText(page, "INDICE:", { x: mm(13), y, size: 24, font: fonts.bold, color: rgb(0.75, 0.12, 0.12) });
  y -= mm(18);
  entries.forEach((entry) => {
    if (entry.type === "group") {
      y -= mm(3);
      const group = fitPdfText(entry.group, fonts.bold, 12, PDF_PAGE.width - mm(26));
      drawPdfText(page, group, { x: mm(13), y, size: 12, font: fonts.bold, color: rgb(0.78, 0.12, 0.12) });
      y -= mm(8);
      return;
    }
    const make = fitPdfText(entry.make, fonts.bold, 12, mm(55));
    drawPdfText(page, make, { x: mm(18), y, size: 12, font: fonts.bold, color: PDF_BLACK });
    page.drawLine({ start: { x: mm(55), y: y + 2 }, end: { x: PDF_PAGE.width - mm(22), y: y + 2 }, thickness: 0.7, color: rgb(0.58, 0.58, 0.58), dashArray: [1, 2] });
    drawPdfText(page, String(entry.page), { x: PDF_PAGE.width - mm(17), y, size: 12, font: fonts.bold, color: PDF_BLACK });
    y -= mm(8);
  });
  drawPdfText(page, String(pageNo), { x: mm(14), y: mm(7), size: 12, font: fonts.bold, color: rgb(1, 1, 1) });
}

function drawPdfProductHeader(page, fonts, title) {
  const headerH = mm(27);
  const y = PDF_PAGE.height - headerH;
  page.drawRectangle({ x: 0, y, width: PDF_PAGE.width * 0.48, height: headerH, color: PDF_RED });
  page.drawRectangle({ x: PDF_PAGE.width * 0.48, y, width: PDF_PAGE.width * 0.52, height: headerH, color: PDF_LIGHT });
  drawPdfText(page, "IPS DO BRASIL", { x: mm(12), y: y + mm(11), size: 20, font: fonts.boldOblique, color: rgb(1, 1, 1) });
  const rightX = PDF_PAGE.width * 0.48;
  const rightW = PDF_PAGE.width * 0.52;
  const fitted = fitPdfText(title, fonts.boldOblique, 17, rightW - mm(18));
  drawPdfText(page, fitted, {
    x: rightX + (rightW - textWidth(fonts.boldOblique, fitted, 17)) / 2,
    y: y + mm(17),
    size: 17,
    font: fonts.boldOblique,
    color: PDF_RED,
  });
  drawPdfText(page, "CATALOGO 2026", {
    x: rightX + (rightW - textWidth(fonts.boldOblique, "CATALOGO 2026", 11)) / 2,
    y: y + mm(3),
    size: 11,
    font: fonts.boldOblique,
    color: PDF_BLACK,
  });
}

function drawPdfFooter(page, fonts, pageNo) {
  const footerH = mm(20);
  page.drawRectangle({ x: 0, y: 0, width: PDF_PAGE.width, height: footerH, color: PDF_DARK_RED });
  const even = pageNo % 2 === 0;
  const pageText = String(pageNo);
  const logoText = "IPS DO BRASIL";
  drawPdfText(page, pageText, {
    x: even ? PDF_PAGE.width - mm(18) : mm(14),
    y: mm(7),
    size: 13,
    font: fonts.bold,
    color: rgb(1, 1, 1),
  });
  drawPdfText(page, "www.ipsbrasil.com.br", {
    x: PDF_PAGE.width / 2 - textWidth(fonts.bold, "www.ipsbrasil.com.br", 13) / 2,
    y: mm(10),
    size: 13,
    font: fonts.bold,
    color: rgb(1, 1, 1),
  });
  const warning = "AS FOTOS CONTIDAS NESSE CATALOGO SAO DE CARATER MERAMENTE ILUSTRATIVO. AS MARCAS DAS MONTADORAS SAO DE FUNCAO INFORMATIVA E COMPARATIVA.";
  drawCenteredPdfLines(page, wrapPdfText(warning, fonts.oblique, 5.4, PDF_PAGE.width - mm(92), 3), fonts.oblique, 5.4, PDF_PAGE.width / 2, mm(7.2), PDF_PAGE.width - mm(92), rgb(1, 1, 1), 6.1);
  drawPdfText(page, logoText, {
    x: even ? mm(10) : PDF_PAGE.width - mm(10) - textWidth(fonts.bold, logoText, 9),
    y: mm(7),
    size: 9,
    font: fonts.bold,
    color: rgb(1, 1, 1),
  });
}

function drawNoImage(page, fonts, x, y, width, height) {
  page.drawRectangle({ x: x + width * 0.26, y: y + height * 0.35, width: width * 0.48, height: height * 0.3, borderColor: PDF_BORDER, borderWidth: 0.7 });
  drawCenteredPdfLines(page, ["IMAGEM", "INDISPONIVEL"], fonts.bold, 10, x + width / 2, y + height * 0.55, width * 0.45, rgb(0.62, 0.62, 0.62), 12);
}

function drawPdfProductCard(page, fonts, item, image, x, y, width, height) {
  const topH = mm(10);
  const textH = mm(25);
  const imageY = y + textH;
  const imageH = height - topH - textH;
  const make = displayText(item.make, item.brand).toUpperCase();
  const vehicle = displayText(firstCatalogVehicle(item.vehicle), "APLICACAO").toUpperCase();
  const description = displayText(item.description, "PRODUTO").toUpperCase();
  const similar = similarCodesText(item.similar);

  page.drawRectangle({ x, y, width, height, color: rgb(1, 1, 1), borderColor: PDF_BORDER, borderWidth: 0.8 });
  page.drawRectangle({ x, y: y + height - topH, width, height: topH, color: PDF_GRAY });
  const titleY = y + height - mm(7);
  const makeText = fitPdfText(make, fonts.boldOblique, 9.5, width * 0.32);
  drawPdfText(page, makeText, { x: x + mm(4), y: titleY, size: 9.5, font: fonts.boldOblique, color: PDF_RED });
  const restX = x + mm(4) + textWidth(fonts.boldOblique, makeText, 9.5) + mm(2);
  const rest = fitPdfText(`// ${vehicle}`, fonts.boldOblique, 9.5, x + width - mm(4) - restX);
  drawPdfText(page, rest, { x: restX, y: titleY, size: 9.5, font: fonts.boldOblique, color: PDF_BLACK });

  page.drawRectangle({ x, y: imageY, width, height: imageH, borderColor: PDF_BORDER, borderWidth: 0.5 });
  if (image) drawImageContain(page, image, x, imageY, width, imageH);
  else drawNoImage(page, fonts, x, imageY, width, imageH);

  page.drawLine({ start: { x, y: y + textH }, end: { x: x + width, y: y + textH }, thickness: 0.6, color: PDF_BORDER });
  const descLines = wrapPdfText(description, fonts.regular, 9, width - mm(8), 2);
  drawCenteredPdfLines(page, descLines, fonts.regular, 9, x + width / 2, y + textH - mm(7), width - mm(8), PDF_BLACK, 10.2);
  const vehicleLines = wrapPdfText(vehicle, fonts.bold, 9.2, width - mm(8), similar ? 1 : 2);
  drawCenteredPdfLines(page, vehicleLines, fonts.bold, 9.2, x + width / 2, y + mm(similar ? 9.5 : 10.5), width - mm(8), PDF_BLACK, 10.5);
  if (similar) {
    const similarLines = wrapPdfText(similar, fonts.regular, 6.4, width - mm(8), 2);
    drawCenteredPdfLines(page, similarLines, fonts.regular, 6.4, x + width / 2, y + mm(5.2), width - mm(8), rgb(0.25, 0.25, 0.25), 7.2);
  }
  if (item.code) {
    drawPdfText(page, String(item.code), { x: x + 1, y: y + 1, size: 1, font: fonts.regular, color: rgb(1, 1, 1), opacity: 0.01 });
  }
}

async function buildCatalogPdfBase64({ items, filters, onProgress, volumeLabel = "" }) {
  const pdfDoc = await PDFDocument.create();
  const fonts = {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
    oblique: await pdfDoc.embedFont(StandardFonts.HelveticaOblique),
    boldOblique: await pdfDoc.embedFont(StandardFonts.HelveticaBoldOblique),
  };
  const model = buildCatalogPdfModel(items, filters);
  const coverImage = await embedPdfImage(pdfDoc, "/images/capa.png");
  const backImage = await embedPdfImage(pdfDoc, "/images/contra_capa.png");
  const imageCache = new Map();

  const cover = pdfDoc.addPage([PDF_PAGE.width, PDF_PAGE.height]);
  if (coverImage) drawImageCover(cover, coverImage, 0, 0, PDF_PAGE.width, PDF_PAGE.height);
  const coverLines = wrapPdfText(model.coverTitle, fonts.bold, 30, PDF_PAGE.width - mm(34), 4);
  coverLines.forEach((line, idx) => {
    const size = 30;
    const x = PDF_PAGE.width / 2 - textWidth(fonts.bold, line, size) / 2;
    const y = PDF_PAGE.height - mm(132) - idx * 36;
    [[-1.2, 0], [1.2, 0], [0, -1.2], [0, 1.2]].forEach(([dx, dy]) =>
      drawPdfText(cover, line, { x: x + dx, y: y + dy, size, font: fonts.bold, color: rgb(1, 1, 1) })
    );
    drawPdfText(cover, line, { x, y, size, font: fonts.bold, color: PDF_RED });
  });
  drawPdfText(cover, "CATALOGO 2026", { x: PDF_PAGE.width - mm(82), y: mm(112), size: 20, font: fonts.bold, color: rgb(1, 1, 1) });
  if (volumeLabel) {
    drawPdfText(cover, volumeLabel, {
      x: PDF_PAGE.width - mm(82),
      y: mm(101),
      size: 12,
      font: fonts.bold,
      color: rgb(1, 1, 1),
    });
  }

  const back = pdfDoc.addPage([PDF_PAGE.width, PDF_PAGE.height]);
  if (backImage) drawImageCover(back, backImage, 0, 0, PDF_PAGE.width, PDF_PAGE.height);

  model.indexPages.forEach((entries, idx) => {
    const page = pdfDoc.addPage([PDF_PAGE.width, PDF_PAGE.height]);
    drawPdfIndexPage(page, fonts, entries, 3 + idx, model.indexLineTitle);
  });

  for (let pageIndex = 0; pageIndex < model.productPages.length; pageIndex += 1) {
    if (onProgress && (pageIndex === 0 || (pageIndex + 1) % 5 === 0 || pageIndex === model.productPages.length - 1)) {
      onProgress(`Gerando PDF: pagina ${pageIndex + 1} de ${model.productPages.length}`);
      await yieldToUi();
    }
    const pageNo = model.firstProductPage + pageIndex;
    const page = pdfDoc.addPage([PDF_PAGE.width, PDF_PAGE.height]);
    drawPdfProductHeader(page, fonts, model.coverTitle);
    drawPdfFooter(page, fonts, pageNo);
    const marginX = mm(10);
    const gap = mm(3);
    const gridTop = PDF_PAGE.height - mm(31);
    const gridBottom = mm(23);
    const cardW = (PDF_PAGE.width - marginX * 2 - gap) / 2;
    const cardH = (gridTop - gridBottom - gap * 2) / 3;
    for (let i = 0; i < model.productPages[pageIndex].length; i += 1) {
      const item = model.productPages[pageIndex][i];
      let image = null;
      if (item.imageSrc) {
        if (!imageCache.has(item.imageSrc)) {
          imageCache.set(
            item.imageSrc,
            await embedPdfImage(pdfDoc, item.imageSrc, {
              downsample: true,
              maxWidth: 1100,
              maxHeight: 700,
              jpegQuality: 0.84,
            })
          );
        }
        image = imageCache.get(item.imageSrc);
      }
      const col = i % 2;
      const row = Math.floor(i / 2);
      const x = marginX + col * (cardW + gap);
      const y = gridTop - (row + 1) * cardH - row * gap;
      drawPdfProductCard(page, fonts, item, image, x, y, cardW, cardH);
    }
  }

  if (onProgress) {
    onProgress("Finalizando arquivo PDF...");
    await yieldToUi();
  }
  return await pdfDoc.saveAsBase64({ dataUri: false });
}

function ensurePdfExtension(path) {
  return /\.pdf$/i.test(String(path || "")) ? path : `${path}.pdf`;
}

function pdfPartPath(path, partIndex, totalParts) {
  const pdfPath = ensurePdfExtension(path);
  if (totalParts <= 1) return pdfPath;
  const suffix = `_parte_${String(partIndex + 1).padStart(2, "0")}`;
  return pdfPath.replace(/\.pdf$/i, `${suffix}.pdf`);
}

function buildPrintParams(filters) {
  return {
    lines: filters.lines,
    groups: filters.groups,
    makes: filters.makes,
    vehicles: filters.vehicles,
    launch_only: filters.launchOnly,
    favorites_only: filters.favoritesOnly,
    limit: 5000,
  };
}

function readDetailValue(product, ...keys) {
  if (!product) return null;
  for (const key of keys) {
    const value = product?.[key];
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

function normalizeProductDetails(raw) {
  if (!raw) return raw;
  return {
    ...raw,
    code: readDetailValue(raw, "code") || "",
    description: readDetailValue(raw, "description") || "",
    brand: readDetailValue(raw, "brand") || "",
    application: readDetailValue(raw, "application"),
    details: readDetailValue(raw, "details"),
    ean_gtin: readDetailValue(raw, "ean_gtin", "eanGtin", "ean", "gtin"),
    altura: readDetailValue(raw, "altura"),
    largura: readDetailValue(raw, "largura"),
    comprimento: readDetailValue(raw, "comprimento"),
    similar: readDetailValue(raw, "similar"),
    images: Array.isArray(raw?.images) ? raw.images : [],
  };
}

function productDetailRows(product) {
  if (!product) return [];
  return [
    readDetailValue(product, "details") ? { label: null, value: readDetailValue(product, "details") } : null,
    readDetailValue(product, "ean_gtin", "eanGtin", "ean", "gtin")
      ? { label: "EAN/GTIN", value: readDetailValue(product, "ean_gtin", "eanGtin", "ean", "gtin") }
      : null,
    readDetailValue(product, "altura") ? { label: "Altura", value: readDetailValue(product, "altura") } : null,
    readDetailValue(product, "largura") ? { label: "Largura", value: readDetailValue(product, "largura") } : null,
    readDetailValue(product, "comprimento")
      ? { label: "Comprimento", value: readDetailValue(product, "comprimento") }
      : null,
  ].filter(Boolean);
}

function App() {
  const fingerprint = useFingerprint();
  const cachedProfile = useMemo(() => safeParseProfile(localStorage.getItem("profile.cached")), []);
  const isDev = import.meta.env.MODE !== "production";
  const updaterRef = useRef(null);
  const settingsRef = useRef(null);

  const [ready, setReady] = useState(false);
  const [dataDir, setDataDir] = useState("");
  const [imagesDir, setImagesDir] = useState("");
  const [dbPath, setDbPath] = useState("");
  const [dbVersion, setDbVersion] = useState(0);
  const [appVersion, setAppVersion] = useState("0.0.0");
  const [configuredVersion, setConfiguredVersion] = useState("");
  const [versionInfo, setVersionInfo] = useState(null);

  const [brands, setBrands] = useState([]);
  const [makes, setMakes] = useState([]);
  const [groups, setGroups] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [allVehicles, setAllVehicles] = useState([]);

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
  const [rcloneRunning, setRcloneRunning] = useState(false);
  const [versionSaving, setVersionSaving] = useState(false);
  const [cleanupScheduled, setCleanupScheduled] = useState(false);

  const [updateInfo, setUpdateInfo] = useState(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [updaterAvailable, setUpdaterAvailable] = useState(false);

  const [launchImages, setLaunchImages] = useState([]);
  const [launchState, setLaunchState] = useState({ open: false, index: 0, loading: false, error: "" });
  const [manifestInput, setManifestInput] = useState("");
  const [toolsMsg, setToolsMsg] = useState("");
  const [excelPath, setExcelPath] = useState("");
  const [exportPath, setExportPath] = useState("");
  const [logoInput, setLogoInput] = useState("");
  const [bgInput, setBgInput] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showPrivacyModal, setShowPrivacyModal] = useState(false);
  const [showPrintModal, setShowPrintModal] = useState(false);
  const [printLoading, setPrintLoading] = useState(false);
  const [printMsg, setPrintMsg] = useState("");
  const [printGroups, setPrintGroups] = useState([]);
  const [printVehicleSearch, setPrintVehicleSearch] = useState("");
  const [printFilters, setPrintFilters] = useState({
    lines: [],
    groups: [],
    makes: [],
    vehicles: [],
    launchOnly: false,
    favoritesOnly: false,
  });

  const [profile, setProfile] = useState(cachedProfile);
  const [authLoading, setAuthLoading] = useState(true);
  const [registrationEmail, setRegistrationEmail] = useState(localStorage.getItem("registration.email") || "");
  const [authSuccess, setAuthSuccess] = useState("");
  const [authError, setAuthError] = useState("");
  const [form, setForm] = useState({ ...REG_DEFAULT, email: registrationEmail });
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [sentOnce, setSentOnce] = useState(false);

  const supabaseConfigured = !!supabase;

  const selectedBrand = useMemo(() => brands.find((b) => String(b.id) === String(brandId)) || null, [brands, brandId]);
  const numericBrandId = useMemo(() => {
    if (brandId === null || brandId === undefined || brandId === "") return null;
    const n = Number(brandId);
    return Number.isNaN(n) ? null : n;
  }, [brandId]);

  const DEFAULT_MANIFEST_URL =
    "https://github.com/BrunoRimbanoJunior/catalogo_ips/releases/latest/download/manifest.json";
  const manifestUrl = useMemo(
    () => localStorage.getItem("manifestUrl") || import.meta.env.VITE_DEFAULT_MANIFEST_URL || DEFAULT_MANIFEST_URL,
    []
  );

  const blockAccess = useMemo(() => {
    if (isDev) return false; // Em desenvolvimento nao bloquear pela aprovacao
    if (cachedProfile?.status === "block" || profile?.status === "block") return true;
    if (cachedProfile?.status === "approved" || profile?.status === "approved") return false;
    return true;
  }, [isDev, supabaseConfigured, cachedProfile, profile]);

  useEffect(() => {
    const preventContextMenu = (event) => {
      event.preventDefault();
      return false;
    };
    // Captura no topo para garantir bloqueio inclusive sobre imagens.
    window.addEventListener("contextmenu", preventContextMenu, { capture: true });
    document.addEventListener("contextmenu", preventContextMenu, { capture: true });
    return () => {
      window.removeEventListener("contextmenu", preventContextMenu, { capture: true });
      document.removeEventListener("contextmenu", preventContextMenu, { capture: true });
    };
  }, []);

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
    const unlisten = listen("images_downloaded", (event) => {
      const downloaded = event?.payload?.downloaded || 0;
      const errors = event?.payload?.errors || 0;
      const msg = `Imagens atualizadas (${downloaded} baixadas${errors ? `, ${errors} erros` : ""}).`;
      setSecondaryStatus(msg);
      setTimeout(() => setSecondaryStatus(""), 2000);
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // Tenta usar o updater nativo do Tauri: baixa e instala sem abrir link externo.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let localVersion = "0.0.0";
      try {
        localVersion = (await getAppVersion()) || "0.0.0";
        if (!cancelled) setAppVersion(localVersion);
      } catch (_) {
        /* ignore */
      }
      try {
        const updater = await import("@tauri-apps/plugin-updater");
        if (!updater?.check) return;
        const res = await updater.check();
        if (res?.available) {
          if (!cancelled) {
            updaterRef.current = res;
            setUpdateInfo({ availableVersion: res.version, downloadUrl: null, source: "tauri" });
            setUpdateDismissed(false);
            setUpdaterAvailable(true);
          }
          return;
        }
      } catch (_) {
        /* se falhar, mantemos o fluxo atual via link */
      }
      try {
        const latest = await fetchLatestRelease();
        if (!latest?.version) return;
        if (compareVersions(latest.version, localVersion) > 0) {
          const platformInfo = await getPlatformInfo();
          const downloadUrl = pickAssetForPlatform(latest.assets, platformInfo.platform, platformInfo.arch) || latest.htmlUrl;
          if (!cancelled) {
            setUpdateInfo({
              availableVersion: latest.version,
              downloadUrl,
              source: "github",
              downloadKind: downloadUrl === latest.htmlUrl ? "page" : "direct",
            });
            setUpdateDismissed(false);
            setUpdaterAvailable(false);
          }
        }
      } catch (_) {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
    if (!ready || cleanupScheduled || !manifestUrl) return undefined;
    const timer = setTimeout(async () => {
      try {
        setToolsMsg("Limpando imagens obsoletas (manifest)...");
        const res = await cleanupImagesFromManifest(manifestUrl);
        setToolsMsg(`Limpeza de imagens concluida: ${res?.removed_files || res?.removedFiles || 0} removidas.`);
      } catch (e) {
        setToolsMsg(`Falha ao limpar imagens: ${e}`);
      }
    }, 15 * 1000); // auto-clean logo apos inicializar, sem travar a primeira carga
    setCleanupScheduled(true);
    return () => clearTimeout(timer);
  }, [ready, cleanupScheduled, manifestUrl]);

  useEffect(() => {
    if (!isDev) return;
    let cancelled = false;
    (async () => {
      try {
        const info = await getAppVersionConfig();
        if (cancelled) return;
        setVersionInfo(info);
        setConfiguredVersion(info?.resolved_version || "");
      } catch (e) {
        if (!cancelled) setToolsMsg(`Falha ao carregar versao configurada: ${e}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isDev]);

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
        setAllVehicles(v);
        setMakes(mk);
        await loadGroupsFor(null, null);
      } catch (e) {
        setStatusMsg(`Falha ao carregar catalogos: ${e}`);
      }

      if (manifestUrl) {
        try {
          setSyncing(true);
          const res = await syncFromManifest(manifestUrl, { skipImages: true });
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
          let cleanupMsg = "";
          try {
            const cleanRes = await cleanupImagesFromManifest(manifestUrl);
            const removed = cleanRes?.removed_files || cleanRes?.removedFiles || 0;
            cleanupMsg = ` Limpeza: ${removed} removidas.`;
          } catch (cleanupError) {
            cleanupMsg = ` Falha na limpeza: ${cleanupError}`;
          }
          setSecondaryStatus(`Indexados ${idxRes?.matched || 0}/${idxRes?.scanned || 0} imagens.${cleanupMsg}`);
        } catch (e) {
          setSecondaryStatus(`Falha ao indexar: ${e}`);
        }
      }

      // Libera UI depois do DB e index
      setReady(true);

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
    if (!showSettings) return;
    const handler = (event) => {
      if (settingsRef.current && !settingsRef.current.contains(event.target)) {
        setShowSettings(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showSettings]);

  useEffect(() => {
    if (!showPrintModal) return;
    const handler = (ev) => {
      if (ev.key === "Escape") setShowPrintModal(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [showPrintModal]);

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

  async function handleUpdateClick(ev) {
    ev?.preventDefault();
    if (updaterRef.current?.downloadAndInstall) {
      try {
        setToolsMsg("Baixando e instalando atualização...");
        await updaterRef.current.downloadAndInstall();
        setToolsMsg("Atualização aplicada. O app pode reiniciar.");
      } catch (e) {
        setToolsMsg(`Falha ao atualizar: ${e.message || e}`);
      }
      return;
    }
    // Fallback to downloading the correct installer when the native updater is not available
    const url = updateInfo?.downloadUrl || GITHUB_RELEASES_LATEST;
    openExternal(url).catch(() => window.open(url, "_blank", "noreferrer"));
  }

  function togglePrintFilter(key, value) {
    setPrintMsg("");
    setPrintFilters((prev) => {
      const current = new Set(prev[key] || []);
      if (current.has(value)) current.delete(value);
      else current.add(value);
      const next = { ...prev, [key]: Array.from(current) };
      if (key === "lines") next.vehicles = [];
      return next;
    });
  }

  function clearPrintFilter(key) {
    setPrintMsg("");
    setPrintFilters((prev) => {
      const next = { ...prev, [key]: [] };
      if (key === "lines") next.vehicles = [];
      return next;
    });
  }

  function updatePrintFlag(key, checked) {
    setPrintMsg("");
    setPrintFilters((prev) => ({ ...prev, [key]: checked }));
  }

  async function loadPrintOptions() {
    setPrintLoading(true);
    try {
      const [{ vehicles: v, makes: mk }, g] = await Promise.all([loadInitialCatalog(), fetchGroups(null, null)]);
      setAllVehicles(v || []);
      setMakes(mk || []);
      setPrintGroups((g || []).filter(Boolean));
    } catch (e) {
      setPrintMsg(`Falha ao carregar filtros: ${e}`);
    } finally {
      setPrintLoading(false);
    }
  }

  async function openPrintFilters() {
    setPrintMsg("");
    setShowSettings(false);
    setShowPrintModal(true);
    await loadPrintOptions();
  }

  async function handleGeneratePrint() {
    setPrintLoading(true);
    setPrintMsg("Preparando catalogo para impressao...");
    try {
      const rows = await fetchPrintCatalog(buildPrintParams(printFilters));
      if (!rows || rows.length === 0) {
        setPrintMsg("Nenhum produto encontrado para os filtros selecionados.");
        return;
      }
      const picked = await saveDialog({
        defaultPath: "catalogo_ips.pdf",
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!picked) {
        setPrintMsg("Geracao cancelada.");
        return;
      }
      const sortedRows = sortCatalogItems(rows);
      const batches = chunkArray(sortedRows, PDF_MAX_ITEMS_PER_FILE);
      const totalParts = batches.length;
      if (totalParts > 1) {
        setPrintMsg(`Selecao grande (${rows.length} itens). O PDF sera dividido em ${totalParts} partes.`);
        await yieldToUi();
      }

      const outputs = [];
      for (let partIndex = 0; partIndex < totalParts; partIndex += 1) {
        const batch = batches[partIndex];
        const volumeLabel = totalParts > 1 ? `PARTE ${partIndex + 1} DE ${totalParts}` : "";
        const items = batch.map((item) => ({
          ...item,
          imageSrc: item?.image || "",
        }));
        const outputPath = pdfPartPath(picked, partIndex, totalParts);
        setPrintMsg(totalParts > 1 ? `Gerando ${volumeLabel} (${items.length} itens)...` : "Gerando arquivo PDF...");
        let pdfBase64 = await buildCatalogPdfBase64({
          items,
          filters: printFilters,
          volumeLabel,
          onProgress: (msg) => setPrintMsg(totalParts > 1 ? `${volumeLabel}: ${msg}` : msg),
        });
        await savePdfBase64(outputPath, pdfBase64);
        pdfBase64 = "";
        outputs.push(outputPath);
        await yieldToUi();
      }
      setPrintMsg(
        totalParts > 1
          ? `PDF dividido em ${totalParts} arquivos com ${rows.length} itens. Primeiro arquivo: ${outputs[0]}`
          : `PDF gerado com ${rows.length} itens: ${outputs[0]}`
      );
    } catch (e) {
      setPrintMsg(`Falha ao gerar impressao: ${e?.message || e}`);
    } finally {
      setPrintLoading(false);
    }
  }

  async function handleGenerateExcel() {
    setPrintLoading(true);
    setPrintMsg("Preparando Excel...");
    try {
      const picked = await saveDialog({
        defaultPath: "catalogo_ips.xlsx",
        filters: [{ name: "Excel", extensions: ["xlsx"] }],
      });
      if (!picked) {
        setPrintMsg("Geracao cancelada.");
        return;
      }
      const res = await exportPrintExcel(buildPrintParams(printFilters), picked);
      if (!res?.rows) {
        setPrintMsg("Nenhum produto encontrado para os filtros selecionados.");
        return;
      }
      setPrintMsg(`Excel gerado com ${res.rows} linhas: ${res.output || picked}`);
    } catch (e) {
      setPrintMsg(`Falha ao gerar Excel: ${e?.message || e}`);
    } finally {
      setPrintLoading(false);
    }
  }

  async function submitRegistration(ev) {
    ev?.preventDefault();
    setAuthSuccess("");
    setAuthError("");
    const validation = validateRegistrationForm(form, registrationEmail);
    if (validation.error) {
      setAuthError(validation.error);
      return;
    }
    setFormSubmitting(true);
    try {
      if (!supabase) throw new Error("Supabase nao configurado.");
      let profileId = profile?.id || null;
      if (!profileId && validation.email) {
        const { data } = await supabase.from("profiles").select("id").eq("email", validation.email).maybeSingle();
        if (data?.id) profileId = data.id;
      }
      const payload = {
        ...form,
        cpf_cnpj: validation.cpfCnpj,
        email: validation.email,
        status: "pending",
        device_fingerprint: profile?.device_fingerprint || fingerprint,
        id: profileId || undefined,
      };
      const { data, error } = await supabase.from("profiles").upsert(payload, { onConflict: "email" }).select().maybeSingle();
      if (error) throw error;
      const resolved = data ? { ...data, status: data.status || "pending" } : null;
      if (resolved) {
        setProfile(resolved);
        if (resolved.status === "approved") {
          localStorage.setItem("profile.cached", JSON.stringify(resolved));
        } else {
          localStorage.removeItem("profile.cached");
        }
      }
      setRegistrationEmail(validation.email);
      setForm((prev) => ({ ...prev, cpf_cnpj: validation.cpfCnpj, email: validation.email }));
      setAuthSuccess("Cadastro enviado. Aguarde aprovacao.");
      setSentOnce(true);
    } catch (e) {
      setAuthError(`Falha ao salvar cadastro: ${e.message || e}`);
    } finally {
      setFormSubmitting(false);
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
      const detail = normalizeProductDetails(await getProductDetails(productId));
      setSelected(detail);
      if (!detail?.images) {
        setSelectedImages([]);
        return;
      }
      const isLaunchAsset = (img) => {
        const lower = String(img || "").toLowerCase();
        return /(^|[\\/])lan[cç]amentos([\\/]|$)/.test(lower);
      };
      const imagesFiltered = (detail.images || []).filter((img) => !isLaunchAsset(img));
      const codeStr = detail?.code ? String(detail.code) : "";
      const listFiltered =
        codeStr && Array.isArray(imagesFiltered) && imagesFiltered.length
          ? imagesFiltered.filter((img) => {
              const lower = String(img || "").toLowerCase();
              return lower.includes(codeStr.toLowerCase());
            })
          : imagesFiltered;
      const imagesList = listFiltered && listFiltered.length ? listFiltered : imagesFiltered;
      const dedupByName = [];
      const seenNames = new Set();
      for (const img of imagesList || []) {
        const fname = String(img || "").split(/[/\\\\]/).pop();
        const key = (fname || "").toLowerCase();
        if (!key) continue;
        if (seenNames.has(key)) continue;
        seenNames.add(key);
        dedupByName.push(img);
      }
      const unique = new Set();
      const imgs = [];
      for (const img of dedupByName) {
        const normalized = normalizePath(imagesDir, img);
        try {
          const src = await loadLocalImageSrc(normalized);
          if (src && !unique.has(src)) {
            unique.add(src);
            imgs.push(src);
          }
        } catch (_) {
          // Se falhar (arquivo ausente/criptografia), apenas ignore para evitar thumbs quebradas
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
          const src = await loadLocalImageSrc(full);
          if (src && !uniq.has(src)) {
            uniq.add(src);
            list.push(src);
          }
        } catch (_) {
          // Se falhar (arquivo ausente/criptografia), apenas ignore para evitar thumbs quebradas
        }
      }
      setLaunchImages(list);
      // Sempre abre o modal quando a lista é carregada manualmente; em auto-init também abrimos para exibir novidades
      setLaunchState((s) => ({ ...s, loading: false, open: true, index: 0 }));
    } catch (e) {
      setLaunchImages([]);
      setLaunchState({ open: false, index: 0, loading: false, error: `Falha ao carregar Lancamentos: ${e.message || e}` });
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
      const idxRes = await indexImagesFromManifest(target);
      const cleanRes = await cleanupImagesFromManifest(target);
      setToolsMsg(
        `Sync concluído. Indexados ${idxRes?.matched || 0}/${idxRes?.scanned || 0}; removidas ${cleanRes?.removed_files || cleanRes?.removedFiles || 0} imagens obsoletas.`
      );
    } catch (e) {
      setToolsMsg(`Falha ao sincronizar: ${e}`);
    } finally {
      setSyncing(false);
    }
  }

  async function runRcloneUpload() {
    setToolsMsg("Executando sincronizacao via rclone. O progresso aparece no terminal do dev...");
    setRcloneRunning(true);
    try {
      const res = await runRcloneSync();
      const exitCode = res?.exit_code ?? res?.exitCode;
      if (res?.ok) {
        setToolsMsg("Sincronizacao via rclone concluida.");
      } else {
        setToolsMsg(
          `Rclone finalizado com erro${exitCode !== undefined && exitCode !== null ? ` (codigo ${exitCode})` : ""}.`
        );
      }
    } catch (e) {
      setToolsMsg(`Falha ao executar rclone: ${e}`);
    } finally {
      setRcloneRunning(false);
    }
  }

  async function saveConfiguredAppVersion() {
    const nextVersion = configuredVersion.trim();
    if (!nextVersion) return;
    setVersionSaving(true);
    try {
      const info = await setAppVersionConfig(nextVersion);
      setVersionInfo(info);
      setConfiguredVersion(info?.resolved_version || nextVersion);
      setToolsMsg(
        `Versao configurada atualizada para ${info?.resolved_version || nextVersion}. O executavel atual continua em ${appVersion} ate rebuild/release.`
      );
    } catch (e) {
      setToolsMsg(`Falha ao salvar versao: ${e}`);
    } finally {
      setVersionSaving(false);
    }
  }

  async function runIndex(manUrl) {
    const target = manUrl || manifestUrl;
    if (!target) return;
    setToolsMsg("Indexando imagens via manifest...");
    try {
      const idxRes = await indexImagesFromManifest(target);
      const cleanRes = await cleanupImagesFromManifest(target);
      setToolsMsg(
        `Indexados ${idxRes?.matched || 0}/${idxRes?.scanned || 0} imagens. Removidas ${cleanRes?.removed_files || cleanRes?.removedFiles || 0} obsoletas.`
      );
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
      setToolsMsg(`Importado: linhas ${res?.processed_rows ?? "?"}, produtos ${res?.upserted_products ?? "?"}, versÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¿ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â½o db ${res?.new_db_version ?? "?"}`);
      const { brands: b, vehicles: v, makes: mk } = await loadInitialCatalog();
      setBrands(b || []);
      setVehicles(v || []);
      setAllVehicles(v || []);
      setMakes(mk || []);
      setPrintGroups((await fetchGroups(null, null)) || []);
      await loadGroupsFor(null, null);
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
  const detailRows = productDetailRows(selected);
  const configuredVersionCurrent = versionInfo?.resolved_version || "";
  const versionDirty = configuredVersion.trim() && configuredVersion.trim() !== configuredVersionCurrent;
  const printVehicleSource = allVehicles.length ? allVehicles : vehicles;
  const printLineOptions = useMemo(
    () => uniqueTextOptions(printVehicleSource.map((v) => v?.category), lineDisplayLabel),
    [printVehicleSource]
  );
  const printGroupOptions = useMemo(() => uniqueTextOptions((printGroups.length ? printGroups : groups) || []), [printGroups, groups]);
  const printMakeOptions = useMemo(() => uniqueTextOptions(makes || []), [makes]);
  const printVehicleOptions = useMemo(
    () => vehiclePrintOptions(printVehicleSource, printVehicleSearch, printFilters.lines),
    [printVehicleSource, printVehicleSearch, printFilters.lines]
  );

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
        {syncing && (
          <div className="sync-overlay" role="alert" aria-live="assertive">
            <div className="sync-box">Atualizando dados, aguarde...</div>
          </div>
        )}
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
                <button className="launch-button" style={{ padding: "6px 10px" }} onClick={(e) => handleUpdateClick(e)}>
                  {updaterAvailable ? "Atualizar agora" : updateInfo?.downloadKind === "direct" ? "Baixar atualizacao" : "Ver no GitHub"}
                </button>
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
                <a href="https://api.whatsapp.com/send/?phone=554130864388&text=Ol%C3%A1%21+Gostaria+de+mais+informa%C3%A7%C3%B5es.&type=phone_number&app_absent=0" target="_blank" rel="noreferrer" aria-label="WhatsApp">
                  <svg viewBox="0 0 24 24"><path d="M12 2a9.9 9.9 0 00-8.4 15.2L2.5 22l4.9-1.1A9.9 9.9 0 1012 2zm0 2a7.9 7.9 0 016.8 11.9 7.9 7.9 0 01-9.1 3.1l-.6-.2-2.3.5.5-2.2-.3-.6A7.9 7.9 0 0112 4zm-3.2 3.9c-.2 0-.5.1-.7.4-.2.3-.9.9-.9 2.2s.9 2.5 1.1 2.7c.1.2 1.8 2.9 4.5 4 .6.3 1.1.4 1.5.5.6.2 1.2.1 1.6.1.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.1-1.2-.1-.1-.2-.2-.5-.4l-1.7-.8c-.3-.1-.5-.1-.7.1-.2.3-.8 1-.9 1.1-.2.2-.3.2-.6.1-.3-.1-1.2-.4-2.3-1.4-.8-.8-1.4-1.7-1.6-2-.2-.3 0-.4.1-.6l.4-.5c.1-.2.2-.3.3-.5.1-.2.1-.4 0-.5l-.8-1.9c-.2-.4-.4-.4-.6-.4z" /></svg>
                </a>
                <a href="mailto:contato@ipsbrasil.com.br" aria-label="Email">
                  <svg viewBox="0 0 24 24"><path d="M4 4h16a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2zm0 2v.2l8 4.8 8-4.8V6H4zm0 3.3V18h16V9.3l-8 4.8-8-4.8z" /></svg>
                </a>
              </nav>
              <div className="app-actions">
                <button className="launch-button" onClick={() => loadLaunches(false)} disabled={launchState.loading}>
                  {launchState.loading ? "Carregando..." : "Lançamentos"}
                </button>
                <button className="print-open-button" onClick={openPrintFilters}>
                  Imprimir
                </button>
              </div>
              {launchState.error ? <span className="launch-error">{launchState.error}</span> : null}
            </div>
            <div className="settings-wrap" ref={settingsRef}>
              <button className="settings-button" onClick={() => setShowSettings((s) => !s)} aria-label="Configuracoes">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M19.14 12.94a7.19 7.19 0 000-1.88l2.03-1.58a.5.5 0 00.12-.64l-1.92-3.32a.5.5 0 00-.6-.22l-2.39.96a7.17 7.17 0 00-1.63-.94l-.36-2.54a.5.5 0 00-.5-.42h-3.84a.5.5 0 00-.5.42l-.36 2.54a7.17 7.17 0 00-1.63.94l-2.39-.96a.5.5 0 00-.6.22L2.7 8.84a.5.5 0 00.12.64l2.03 1.58a7.19 7.19 0 000 1.88L2.82 14.52a.5.5 0 00-.12.64l1.92 3.32a.5.5 0 00.6.22l2.39-.96c.5.38 1.05.7 1.63.94l.36 2.54a.5.5 0 00.5.42h3.84a.5.5 0 00.5-.42l.36-2.54c.58-.24 1.13-.56 1.63-.94l2.39.96a.5.5 0 00.6-.22l1.92-3.32a.5.5 0 00-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1115.5 12 3.5 3.5 0 0112 15.5z" />
                </svg>
              </button>
              {showSettings && (
                <div className="settings-menu">
                  <button
                    type="button"
                    onClick={() => {
                      setShowProfileModal(true);
                      setShowSettings(false);
                    }}
                  >
                    Meu cadastro
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowPrivacyModal(true);
                      setShowSettings(false);
                    }}
                  >
                    Politica de Privacidade
                  </button>
                </div>
              )}
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
                  <button onClick={runRcloneUpload} disabled={rcloneRunning || syncing}>
                    {rcloneRunning ? "Sincronizando rclone..." : "Executar rclone"}
                  </button>
                  <button onClick={() => loadLaunches(true)} disabled={launchState.loading}>
                    Abrir Lancamentos
                  </button>
                </div>
                <span style={{ gridColumn: "1 / -1", fontSize: 12, color: "#555" }}>
                  O botao acima usa o comando salvo em rclone.txt e mostra o progresso no terminal do dev.
                </span>
                <div style={{ gridColumn: "1 / -1", display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "center" }}>
                  <input
                    placeholder="Versao da proxima build"
                    value={configuredVersion}
                    onChange={(e) => setConfiguredVersion(e.target.value)}
                  />
                  <button onClick={saveConfiguredAppVersion} disabled={versionSaving || !configuredVersion.trim() || !versionDirty}>
                    {versionSaving ? "Salvando versao..." : "Salvar versao"}
                  </button>
                  <span style={{ gridColumn: "1 / -1", fontSize: 12, color: "#555" }}>
                    Executavel atual: {appVersion} | Configurada: {configuredVersionCurrent || "?"}{" "}
                    {versionInfo?.consistent ? "(arquivos sincronizados)" : "(arquivos com versoes diferentes)"}
                  </span>
                  {versionInfo ? (
                    <span style={{ gridColumn: "1 / -1", fontSize: 12, color: "#555" }}>
                      package.json {versionInfo.package_json_version} | Cargo.toml {versionInfo.cargo_toml_version} | tauri.conf.json{" "}
                      {versionInfo.tauri_conf_version}
                      {versionInfo.cargo_lock_version ? ` | Cargo.lock ${versionInfo.cargo_lock_version}` : ""}
                    </span>
                  ) : null}
                </div>
                <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button onClick={runImportExcel}>Importar Excel</button>
                  {excelPath ? <span style={{ fontSize: 12, color: "#555" }}>Ultimo: {excelPath}</span> : null}
                  <button onClick={runExportDb}>Exportar DB</button>
                  {exportPath ? <span style={{ fontSize: 12, color: "#555" }}>Ultimo: {exportPath}</span> : null}
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
                {(() => {
                  const seen = new Set();
                  const opts = [];
                  for (const v of vehicles) {
                    const label = vehicleLabel(v.name);
                    if (!label) continue;
                    const key = label.toUpperCase();
                    if (seen.has(key)) continue;
                    seen.add(key);
                    opts.push([label, v.id]);
                  }
                  return opts.map(([label, id]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ));
                })()}
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
                        <div style={{ opacity: 0.9 }}>
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
                {detailRows.length > 0 ? (
                  <>
                    <div className="sep" />
                    <div>
                      <div className="subtitle">Detalhes:</div>
                      <div className="details-text">
                        {detailRows.map((row, idx) => (
                          <div key={`${row.label || "texto"}-${idx}`}>
                            {row.label ? <strong>{row.label}:</strong> : null}
                            {row.label ? " " : ""}
                            {row.value}
                          </div>
                        ))}
                      </div>
                    </div>
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

      {showProfileModal && (
        <div className="config-backdrop" onClick={() => setShowProfileModal(false)}>
          <div className="config-modal" onClick={(e) => e.stopPropagation()}>
            <div className="config-header">
              <h3>Meu cadastro</h3>
              <button className="config-close" onClick={() => setShowProfileModal(false)} aria-label="Fechar">
                X
              </button>
            </div>
            {supabaseConfigured ? (
              <form className="auth-grid" onSubmit={submitRegistration}>
                <div className="auth-radio">
                  <label>
                    <input type="radio" name="personTypeConfig" checked={form.person_type === "pj"} onChange={() => setForm((s) => ({ ...s, person_type: "pj" }))} /> Pessoa Juridica
                  </label>
                  <label>
                    <input type="radio" name="personTypeConfig" checked={form.person_type === "pf"} onChange={() => setForm((s) => ({ ...s, person_type: "pf" }))} /> Pessoa Fisica
                  </label>
                </div>

                <label className="auth-field wide">
                  Nome/Razao Social
                  <input value={form.full_name} onChange={(e) => setForm((s) => ({ ...s, full_name: e.target.value }))} placeholder="Nome completo ou razão social" />
                </label>
                <label className="auth-field wide">
                  CPF/CNPJ
                  <input inputMode="numeric" value={form.cpf_cnpj} onChange={(e) => setForm((s) => ({ ...s, cpf_cnpj: e.target.value }))} placeholder={form.person_type === "pj" ? "00.000.000/0000-00" : "000.000.000-00"} />
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
                  <input value={form.city} onChange={(e) => setForm((s) => ({ ...s, city: e.target.value }))} placeholder="CIDADE" />
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
                  <input type="email" inputMode="email" autoCapitalize="none" value={form.email || registrationEmail} onChange={(e) => setForm((s) => ({ ...s, email: e.target.value }))} placeholder="usuario@empresa.com" />
                </label>

                <div className="auth-meta">
                  <span>Codigo do cadastro: {profile?.id || "aguardando.."}</span>
                  <span>Dispositivo vinculado: {profile?.device_fingerprint || fingerprint}</span>
                </div>

                <button type="submit" disabled={formSubmitting}>
                  {formSubmitting ? "Salvando..." : "Salvar dados"}
                </button>
                {authSuccess && <div className="auth-success">{authSuccess}</div>}
                {authError && <div className="auth-error">{authError}</div>}
              </form>
            ) : (
              <div className="auth-alert">Configure VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY no .env antes de liberar o acesso.</div>
            )}
          </div>
        </div>
      )}

      {showPrivacyModal && (
        <div className="config-backdrop" onClick={() => setShowPrivacyModal(false)}>
          <div className="config-modal" onClick={(e) => e.stopPropagation()}>
            <div className="config-header">
              <h3>Politica de Privacidade / LGPD</h3>
              <button className="config-close" onClick={() => setShowPrivacyModal(false)} aria-label="Fechar">
                X
              </button>
            </div>
            <div className="privacy-body">
              <p>Para continuar utilizando esse Catálogo é necessário concordar com a Politica de Privacidade.</p>
              <p>Você já se cadastrou nesse Catálogo e pode consultar, alterar ou excluir o seu Cadastro a qualquer momento, através do botão Configurações.</p>
              <p>Informamos que coletamos dados ref. à utilização do catálogo para fins estatísticos e melhoria desse produto.</p>
              <p>
                Para saber mais, verifique a nossa{" "}
                <button className="privacy-link" onClick={() => openExternal("http://ipsbrasil.com.br/politica_privacidade/")}>
                  Politica de Privacidade
                </button>
                .
              </p>
            </div>
          </div>
        </div>
      )}

      {showPrintModal && (
        <div className="config-backdrop print-backdrop" onClick={() => setShowPrintModal(false)}>
          <div className="config-modal print-modal" onClick={(e) => e.stopPropagation()}>
            <div className="config-header print-modal-header">
              <div>
                <p className="auth-kicker">Impressao</p>
                <h3>Gerador de Impressao</h3>
              </div>
              <button className="config-close" onClick={() => setShowPrintModal(false)} aria-label="Fechar">
                X
              </button>
            </div>

            <div className="print-divider" aria-hidden="true">
              <span />
              <div className="print-divider-icon">
                <svg viewBox="0 0 24 24">
                  <path d="M4 5.5C5.7 4.7 7.4 4.3 9.2 4.3c1.3 0 2.3.2 2.8.7.5-.5 1.5-.7 2.8-.7 1.8 0 3.5.4 5.2 1.2v13.4c-1.7-.8-3.4-1.2-5.2-1.2-1.3 0-2.3.2-2.8.7-.5-.5-1.5-.7-2.8-.7-1.8 0-3.5.4-5.2 1.2V5.5Zm7 1.2c-.3-.3-.9-.4-1.8-.4-1.1 0-2.2.2-3.2.5v9.5c1-.3 2.1-.5 3.2-.5.7 0 1.3.1 1.8.3V6.7Zm2 9.4c.5-.2 1.1-.3 1.8-.3 1.1 0 2.2.2 3.2.5V6.8c-1-.3-2.1-.5-3.2-.5-.9 0-1.5.1-1.8.4v9.4Z" />
                </svg>
              </div>
              <span />
            </div>

            {printLoading ? <div className="auth-wait">Carregando filtros...</div> : null}

            <div className="print-grid">
              <PrintFilterList
                title="Linhas de Veiculos"
                options={printLineOptions}
                selected={printFilters.lines}
                onToggle={(value) => togglePrintFilter("lines", value)}
                onClear={() => clearPrintFilter("lines")}
                emptyText="Nenhuma linha encontrada."
              />
              <PrintFilterList
                title="Grupos"
                options={printGroupOptions}
                selected={printFilters.groups}
                onToggle={(value) => togglePrintFilter("groups", value)}
                onClear={() => clearPrintFilter("groups")}
                emptyText="Nenhum grupo encontrado."
              />
              <PrintFilterList
                title="Montadoras"
                options={printMakeOptions}
                selected={printFilters.makes}
                onToggle={(value) => togglePrintFilter("makes", value)}
                onClear={() => clearPrintFilter("makes")}
                emptyText="Nenhuma montadora encontrada."
              />
              <PrintFilterList
                title="Veiculos"
                options={printVehicleOptions}
                selected={printFilters.vehicles}
                onToggle={(value) => togglePrintFilter("vehicles", value)}
                onClear={() => clearPrintFilter("vehicles")}
                emptyText="Nenhum veiculo encontrado."
              >
                <div className="print-search-row">
                  <span className="print-search-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24">
                      <path d="M10.5 4a6.5 6.5 0 0 1 5.13 10.5l4.44 4.43-1.42 1.42-4.43-4.44A6.5 6.5 0 1 1 10.5 4Zm0 2a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Z" />
                    </svg>
                  </span>
                  <input value={printVehicleSearch} onChange={(e) => setPrintVehicleSearch(e.target.value)} />
                  <button type="button" onClick={() => setPrintVehicleSearch("")}>
                    Limpar
                  </button>
                </div>
              </PrintFilterList>
            </div>

            <div className="print-footer">
              <div className="print-flags">
                <label className="print-flag">
                  <input
                    type="checkbox"
                    checked={printFilters.launchOnly}
                    onChange={(e) => updatePrintFlag("launchOnly", e.target.checked)}
                  />
                  <span>Lancamento</span>
                </label>
                <label className="print-flag">
                  <input
                    type="checkbox"
                    checked={printFilters.favoritesOnly}
                    onChange={(e) => updatePrintFlag("favoritesOnly", e.target.checked)}
                  />
                  <span>Imprime Itens Favoritos</span>
                </label>
              </div>
              <div className="print-actions">
                <button className="print-submit print-submit-secondary" type="button" onClick={handleGenerateExcel} disabled={printLoading}>
                  {printLoading ? "Preparando..." : "Gerar Excel"}
                </button>
                <button className="print-submit" type="button" onClick={handleGeneratePrint} disabled={printLoading}>
                  {printLoading ? "Preparando..." : "Imprimir (Gerar PDF)"}
                </button>
              </div>
            </div>
            {printMsg ? <div className="print-message">{printMsg}</div> : null}
          </div>
        </div>
      )}

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
                <p className="auth-muted">Envie a ficha e Aguarde aprovaÃ§Ã£o. Enquanto o status nÃ£o for aprovado, o catÃ¡logo fica bloqueado.</p>
                <p className="auth-status">Status atual: {profile?.status || "pending"}</p>
              </div>
              <div className="auth-brand">CatÃ¡logo IPS</div>
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
                          <input type="radio" name="personType" checked={form.person_type === "pj"} onChange={() => setForm((s) => ({ ...s, person_type: "pj" }))} /> Pessoa Juridica
                        </label>
                        <label>
                          <input type="radio" name="personType" checked={form.person_type === "pf"} onChange={() => setForm((s) => ({ ...s, person_type: "pf" }))} /> Pessoa Fisica
                        </label>
                      </div>

                      <label className="auth-field wide">
                        Nome/Razao Social
                        <input value={form.full_name} onChange={(e) => setForm((s) => ({ ...s, full_name: e.target.value }))} placeholder="Nome completo ou razão social" />
                      </label>
                      <label className="auth-field wide">
                        CPF/CNPJ
                        <input inputMode="numeric" value={form.cpf_cnpj} onChange={(e) => setForm((s) => ({ ...s, cpf_cnpj: e.target.value }))} placeholder={form.person_type === "pj" ? "00.000.000/0000-00" : "000.000.000-00"} />
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
                        <input value={form.city} onChange={(e) => setForm((s) => ({ ...s, city: e.target.value }))} placeholder="CIDADE" />
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
                        <input type="email" inputMode="email" autoCapitalize="none" value={form.email || registrationEmail} onChange={(e) => setForm((s) => ({ ...s, email: e.target.value }))} placeholder="usuario@empresa.com" />
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
