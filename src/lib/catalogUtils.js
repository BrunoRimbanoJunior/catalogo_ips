import { convertFileSrc } from "@tauri-apps/api/core";

export const DEFAULT_LOGO = "/images/logo.png";
export const DEFAULT_BACKGROUND = "/images/bg.png";
export const HEADER_LOGO_PREFIX = "/images";

export function safeParseProfile(raw) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

export function sanitizeStoredPath(raw, fallback = "") {
  const trimmed = (raw || "").trim();
  if (!trimmed) return fallback;
  const lower = trimmed.toLowerCase();
  if (lower === "null" || lower === "undefined") return fallback;
  return trimmed;
}

export function parseStoredArray(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim());
    }
  } catch (_) {
    /* ignore */
  }
  return [];
}

export function toHeaderLogoPath(name) {
  if (!name) return "";
  if (name.startsWith("http://") || name.startsWith("https://")) return name;
  if (name.startsWith("/")) {
    return name
      .split("/")
      .map((p, idx) => (idx === 0 ? p : encodeURIComponent(p)))
      .join("/");
  }
  const clean = name.replace(/^\.?\/?images\/?/i, "");
  return `${HEADER_LOGO_PREFIX}/${clean}`.replace(/\\/g, "/");
}

export function normalizePath(base, maybeRelative) {
  if (!maybeRelative) return base;
  const absolute = maybeRelative.startsWith("/") || /^[A-Za-z]:\\/.test(maybeRelative);
  if (absolute) return maybeRelative.replace(/\\/g, "/");
  const sep = base.endsWith("/") || base.endsWith("\\") ? "" : "/";
  return `${base}${sep}${maybeRelative}`.replace(/\\/g, "/");
}

export function toDisplaySrc(path) {
  if (!path) return "";
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  if (path.startsWith("/")) {
    const parts = path.split("/").map((p, idx) => (idx === 0 ? p : encodeURIComponent(p)));
    return parts.join("/");
  }
  if (/^[A-Za-z]:\\/.test(path) || path.startsWith("\\\\")) return convertFileSrc(path);
  const clean = path.replace(/^\.?\/?images\/?/i, "");
  const encoded = clean.split("/").map((p) => encodeURIComponent(p)).join("/");
  return `/images/${encoded}`;
}

export function compareVersions(a = "0.0.0", b = "0.0.0") {
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

export async function getAppVersion() {
  try {
    const mod = await import("@tauri-apps/api/app");
    if (mod?.getVersion) return await mod.getVersion();
  } catch (_) {
    /* ignore */
  }
  return import.meta.env.VITE_APP_VERSION || "0.0.0";
}
