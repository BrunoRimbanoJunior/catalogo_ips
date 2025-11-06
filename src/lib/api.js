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

export async function getProductDetails(productId) {
  return await invoke("get_product_details_cmd", { productId });
}

export async function syncFromManifest(manifestUrl) {
  return await invoke("sync_from_manifest", { manifestUrl });
}

export async function importExcel(path) {
  return await invoke("import_excel", { path });
}

export async function indexImages(root) {
  return await invoke("index_images", { root });
}

export async function fetchMakes() {
  return await invoke("get_makes_cmd");
}

export async function fetchVehiclesByMake(make) {
  return await invoke("get_vehicles_by_make_cmd", { make });
}

export async function fetchTypes(brandId) {
  return await invoke("get_types_cmd", { brandId });
}

export async function fetchGroups(brandId) {
  return await invoke("get_groups_cmd", { brand_id: brandId });
}

export async function fetchVehiclesFiltered(brandId, group) {
  return await invoke("get_vehicles_filtered_cmd", { brand_id: brandId, group });
}

export async function fetchGroupsStats() {
  return await invoke("get_groups_stats_cmd");
}

export async function indexImagesFromManifest(manifestUrl) {
  return await invoke("index_images_from_manifest", { manifestUrl });
}

export async function exportDbTo(destPath) {
  return await invoke("export_db_to", { destPath });
}

export async function setBrandingImage(kind, path) {
  return await invoke("set_branding_image", { kind, sourcePath: path });
}

