import { invoke } from "@tauri-apps/api/core";

export async function initApp() {
  return await invoke("init_app");
}

export async function fetchBrands() {
  return await invoke("get_brands_cmd");
}

export async function fetchVehicles() {
  return await invoke("get_vehicles_cmd");
}

export async function searchProducts(params) {
  return await invoke("search_products_cmd", { params });
}

export async function fetchPrintCatalog(params) {
  return await invoke("get_print_catalog_cmd", { params });
}

export async function exportPrintExcel(params, path) {
  return await invoke("export_print_excel_cmd", { params, path });
}

export async function getProductDetails(productId) {
  return await invoke("get_product_details_cmd", { productId });
}

export async function syncFromManifest(manifestUrl, opts = {}) {
  return await invoke("sync_from_manifest", { manifestUrl, skipImages: !!opts.skipImages });
}

export async function importExcel(path) {
  return await invoke("import_excel", { path });
}

export async function fetchMakes() {
  return await invoke("get_makes_cmd");
}

export async function fetchGroups(brandId, brandName) {
  const numericId = brandId === undefined || brandId === null || brandId === "" ? null : Number(brandId);
  return await invoke("get_groups_cmd", {
    brand_id: numericId,
    brandId: numericId,
    brand_name: brandName,
    brandName,
  });
}

export async function fetchVehiclesFiltered(brandId, group, make) {
  return await invoke("get_vehicles_filtered_cmd", { brand_id: brandId, group, make });
}

export async function indexImagesFromManifest(manifestUrl) {
  return await invoke("index_images_from_manifest", { manifestUrl });
}

export async function cleanupImagesFromManifest(manifestUrl) {
  return await invoke("cleanup_images_from_manifest", { manifestUrl });
}

export async function exportDbTo(destPath) {
  return await invoke("export_db_to", { destPath });
}

export async function setBrandingImage(kind, path) {
  return await invoke("set_branding_image", { kind, sourcePath: path });
}

export async function setHeaderLogos(paths) {
  return await invoke("set_header_logos", { paths });
}

export async function refreshBrandingConfig() {
  return await invoke("refresh_branding_config");
}

export async function readImageBase64(pathOrRel) {
  return await invoke("read_image_base64", { pathOrRel });
}

export async function savePdfBase64(path, dataBase64) {
  return await invoke("save_pdf_base64", { path, dataBase64 });
}

export async function listLaunchImages() {
  return await invoke("list_launch_images");
}

export async function runRcloneSync() {
  return await invoke("run_rclone_sync");
}

export async function getAppVersionConfig() {
  return await invoke("get_app_version_config");
}

export async function setAppVersionConfig(version) {
  return await invoke("set_app_version_config", { version });
}

