import {
  fetchBrands,
  fetchVehicles,
  fetchMakes,
  fetchGroups,
  fetchVehiclesFiltered,
  searchProducts,
} from "./api";

function toNumeric(id) {
  if (id === undefined || id === null || id === "") return null;
  const n = Number(id);
  return Number.isNaN(n) ? null : n;
}

export async function loadInitialCatalog() {
  const [brands, vehicles, makes] = await Promise.all([fetchBrands(), fetchVehicles(), fetchMakes()]);
  return {
    brands: brands || [],
    vehicles: vehicles || [],
    makes: makes || [],
  };
}

export async function loadGroups(brandId, brandName) {
  const numericId = toNumeric(brandId);
  return await fetchGroups(numericId, brandName || null);
}

export async function loadVehiclesByFilters(brandId, group, make) {
  const numericId = toNumeric(brandId);
  return await fetchVehiclesFiltered(numericId, group || null, make || null);
}

export async function searchWithFilters({ brandId, group, vehicleId, make, codeQuery, limit = 200 }) {
  const numericBrand = toNumeric(brandId);
  const numericVehicle = toNumeric(vehicleId);
  return await searchProducts({
    brand_id: numericBrand,
    group: group || null,
    vehicle_id: numericVehicle,
    make: make || null,
    code_query: codeQuery || null,
    limit,
  });
}
