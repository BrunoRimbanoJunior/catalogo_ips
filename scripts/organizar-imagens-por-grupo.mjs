#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const DEFAULT_ROOT = "C:/Users/jubar/OneDrive/IPS_BRASIL/IMAGENS/CATALOGO_ELETRONICO";
const DEFAULT_DB = resolveDefaultDbPath();
const NO_PRODUCT_FOLDER = "SEM_CADASTRO";

const GROUP_FOLDER_ALIASES = new Map([
  ["BOMBA DE DIRECAO HIDRAULICA", "BOMBAS"],
  ["CAIXA DE DIRECAO", "CAIXA_DIRECAO"],
  ["ELETROVENTILADORES", "ELETROVENTILADOR"],
  ["FAROIS E LANTERNAS", "FAROIS"],
  ["KIT CORRENTE DE COMANDO", "KIT CORRENTE"],
  ["RESERVATORIOS", "RESERVATORIO"],
  ["RETROVISOR", "RETROVISORES"],
  ["SEMI EIXOS", "SEMI-EIXO"],
]);

const DEFAULT_SKIP_TOP_LEVEL = new Set(["LANCAMENTOS"]);
const ALLOWED_FILE_EXTENSIONS = new Set([
  ".bmp",
  ".cimg",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
]);

function resolveDefaultDbPath() {
  const candidates = [
    path.join(projectRoot, "data", "catalog.db"),
    path.join(projectRoot, "catalog.db"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function usage() {
  console.log(`
Uso:
  pnpm organizar-imagens [--apply] [--verbose] [--include-launches]
  pnpm organizar-imagens --root "C:/caminho/imagens" --db "C:/caminho/catalog.db"

Padrao:
  - roda em dry-run
  - pula a pasta LANCAMENTOS
  - arquivos sem codigo/grupo vao para ${NO_PRODUCT_FOLDER} no --apply
  - usa:
    root = ${DEFAULT_ROOT}
    db   = ${DEFAULT_DB}

Opcoes:
  --apply             Move os arquivos de fato
  --verbose           Lista mais exemplos no console
  --include-launches  Inclui arquivos da pasta LANCAMENTOS
  --create-missing    Cria pasta quando o grupo nao tiver destino resolvido
  --report <arquivo>  Salva um JSON com o resumo da execucao
  --root <pasta>      Pasta raiz das imagens
  --db <arquivo>      Caminho do catalog.db
  --help              Mostra esta ajuda
`);
}

function parseArgs(argv) {
  const out = {
    apply: false,
    verbose: false,
    includeLaunches: false,
    createMissing: false,
    report: null,
    root: DEFAULT_ROOT,
    db: DEFAULT_DB,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--apply":
        out.apply = true;
        break;
      case "--verbose":
        out.verbose = true;
        break;
      case "--include-launches":
        out.includeLaunches = true;
        break;
      case "--create-missing":
        out.createMissing = true;
        break;
      case "--report":
        out.report = argv[i + 1] || null;
        i += 1;
        break;
      case "--root":
        out.root = argv[i + 1] || out.root;
        i += 1;
        break;
      case "--db":
        out.db = argv[i + 1] || out.db;
        i += 1;
        break;
      case "--help":
      case "-h":
        usage();
        process.exit(0);
        break;
      default:
        if (arg.startsWith("--")) {
          console.error(`Opcao desconhecida: ${arg}`);
          usage();
          process.exit(1);
        }
        break;
    }
  }

  out.root = path.resolve(out.root);
  out.db = path.resolve(out.db);
  return out;
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function candidateCodes(stem) {
  const source = String(stem || "").trim();
  const upper = source.toUpperCase();
  const set = new Set();

  if (upper) {
    set.add(upper);
  }

  for (const sep of ["_", "-", " "]) {
    const index = upper.indexOf(sep);
    if (index > 0) {
      set.add(upper.slice(0, index));
    }
  }

  const onlyAlnum = upper.replace(/[^A-Z0-9]/g, "");
  if (onlyAlnum) {
    set.add(onlyAlnum);
  }

  const digitsPrefix = (upper.match(/^\d+/) || [""])[0];
  if (digitsPrefix) {
    set.add(digitsPrefix);
  }

  return [...set].sort();
}

function isAllowedFile(fileName) {
  const lower = fileName.toLowerCase();
  for (const ext of ALLOWED_FILE_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      return true;
    }
  }
  return false;
}

function sanitizeFolderName(groupName) {
  const cleaned = String(groupName || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return cleaned || "SEM_GRUPO";
}

function collectFiles(dirPath, skipRootNames, currentRootName = null) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const topLevelName = currentRootName || entry.name;

    if (entry.isDirectory()) {
      if (!currentRootName && skipRootNames.has(normalizeText(entry.name))) {
        continue;
      }
      files.push(...collectFiles(fullPath, skipRootNames, topLevelName));
      continue;
    }

    if (!entry.isFile() || !isAllowedFile(entry.name)) {
      continue;
    }

    files.push({
      currentFolder: topLevelName,
      fullPath,
      name: entry.name,
      relativePath: path.relative(dirPath, fullPath),
    });
  }

  return files;
}

function moveFile(source, destination) {
  try {
    fs.renameSync(source, destination);
    return;
  } catch (error) {
    if (error && error.code !== "EXDEV") {
      throw error;
    }
  }

  fs.copyFileSync(source, destination);
  fs.unlinkSync(source);
}

async function loadCodeGroupMap(dbPath) {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(dbPath));
  const map = new Map();
  const statement = db.prepare(`
    SELECT UPPER(TRIM(code)) AS code, TRIM(COALESCE(pgroup, '')) AS pgroup
    FROM products
    WHERE TRIM(COALESCE(pgroup, '')) <> ''
  `);

  while (statement.step()) {
    const row = statement.getAsObject();
    map.set(String(row.code || ""), String(row.pgroup || ""));
  }

  statement.free();
  db.close();
  return map;
}

function resolveExpectedFolder(groupName, folderMap, createMissing) {
  const normalizedGroup = normalizeText(groupName);

  if (GROUP_FOLDER_ALIASES.has(normalizedGroup)) {
    return GROUP_FOLDER_ALIASES.get(normalizedGroup);
  }

  if (folderMap.has(normalizedGroup)) {
    return folderMap.get(normalizedGroup);
  }

  if (!createMissing) {
    return null;
  }

  const createdName = sanitizeFolderName(groupName);
  folderMap.set(normalizedGroup, createdName);
  return createdName;
}

function registerMove(result, file, expectedFolder, meta) {
  const sourcePath = file.fullPath;
  const targetDir = path.join(result.root, expectedFolder);
  const targetPath = path.join(targetDir, path.basename(file.name));

  if (normalizeText(file.currentFolder) === normalizeText(expectedFolder)) {
    if (meta.moveKind === "sem-cadastro") {
      result.noProductAlreadyCorrect += 1;
    } else {
      result.alreadyCorrect += 1;
    }
    return;
  }

  const moveItem = {
    code: meta.code ?? null,
    currentFolder: file.currentFolder,
    expectedFolder,
    group: meta.group ?? null,
    moveKind: meta.moveKind,
    name: file.name,
    sourcePath,
    targetPath,
  };

  if (fs.existsSync(targetPath)) {
    result.conflicts.push(moveItem);
    return;
  }

  result.moves.push(moveItem);
  if (meta.moveKind === "sem-cadastro") {
    result.noProductPlanned += 1;
  }

  if (!result.apply) {
    return;
  }

  try {
    fs.mkdirSync(targetDir, { recursive: true });
    moveFile(sourcePath, targetPath);
    result.moved += 1;
    if (meta.moveKind === "sem-cadastro") {
      result.noProductMoved += 1;
    }
  } catch (error) {
    result.errors.push({
      ...moveItem,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function buildSummary(result) {
  return {
    mode: result.apply ? "apply" : "dry-run",
    root: result.root,
    db: result.db,
    scannedFiles: result.scannedFiles,
    productMatches: result.productMatches,
    alreadyCorrect: result.alreadyCorrect,
    plannedMoves: result.moves.length,
    moved: result.moved,
    skippedSpecialFolders: result.skippedSpecialFolders,
    noProductFolder: NO_PRODUCT_FOLDER,
    noProductDetected: result.noProductDetected,
    noProductAlreadyCorrect: result.noProductAlreadyCorrect,
    noProductPlanned: result.noProductPlanned,
    noProductMoved: result.noProductMoved,
    unresolvedGroup: result.unresolvedGroup.length,
    conflicts: result.conflicts.length,
    errors: result.errors.length,
  };
}

function printSection(title, items, formatter) {
  if (!items.length) {
    return;
  }
  console.log(`\n${title}`);
  for (const item of items) {
    console.log(formatter(item));
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(options.root) || !fs.statSync(options.root).isDirectory()) {
    throw new Error(`Pasta raiz invalida: ${options.root}`);
  }

  if (!fs.existsSync(options.db) || !fs.statSync(options.db).isFile()) {
    throw new Error(`Banco invalido: ${options.db}`);
  }

  const topLevelDirs = fs
    .readdirSync(options.root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());
  const folderMap = new Map(topLevelDirs.map((entry) => [normalizeText(entry.name), entry.name]));
  const skipRootNames = new Set(
    options.includeLaunches ? [] : [...DEFAULT_SKIP_TOP_LEVEL].map((name) => normalizeText(name))
  );
  const codeGroupMap = await loadCodeGroupMap(options.db);
  const files = collectFiles(options.root, skipRootNames);

  const result = {
    ...options,
    scannedFiles: files.length,
    productMatches: 0,
    alreadyCorrect: 0,
    moved: 0,
    skippedSpecialFolders: options.includeLaunches ? [] : [...DEFAULT_SKIP_TOP_LEVEL],
    noProductDetected: 0,
    noProductAlreadyCorrect: 0,
    noProductPlanned: 0,
    noProductMoved: 0,
    moves: [],
    conflicts: [],
    unresolvedGroup: [],
    errors: [],
    noProductExamples: [],
  };

  for (const file of files) {
    const parsed = path.parse(file.name);
    let matchedCode = null;
    let matchedGroup = null;

    for (const code of candidateCodes(parsed.name)) {
      if (codeGroupMap.has(code)) {
        matchedCode = code;
        matchedGroup = codeGroupMap.get(code);
        break;
      }
    }

    if (!matchedGroup) {
      result.noProductDetected += 1;
      if (result.noProductExamples.length < (options.verbose ? 25 : 10)) {
        result.noProductExamples.push(file);
      }
      registerMove(result, file, NO_PRODUCT_FOLDER, {
        moveKind: "sem-cadastro",
      });
      continue;
    }

    result.productMatches += 1;

    const expectedFolder = resolveExpectedFolder(matchedGroup, folderMap, options.createMissing);
    if (!expectedFolder) {
      result.unresolvedGroup.push({
        code: matchedCode,
        currentFolder: file.currentFolder,
        group: matchedGroup,
        name: file.name,
      });
      continue;
    }

    registerMove(result, file, expectedFolder, {
      code: matchedCode,
      group: matchedGroup,
      moveKind: "grupo",
    });
  }

  const summary = buildSummary(result);
  console.log(JSON.stringify(summary, null, 2));

  const movePreview = result.moves.slice(0, options.verbose ? 50 : 15);
  printSection("Movimentos previstos:", movePreview, (item) => {
    if (item.moveKind === "sem-cadastro") {
      return `- ${item.name} | ${item.currentFolder} -> ${item.expectedFolder} | sem codigo/grupo no banco`;
    }
    return `- ${item.name} | ${item.currentFolder} -> ${item.expectedFolder} | codigo ${item.code} | grupo ${item.group}`;
  });

  const conflictPreview = result.conflicts.slice(0, options.verbose ? 25 : 10);
  printSection("Conflitos (destino ja existe):", conflictPreview, (item) => {
    return `- ${item.name} | ${item.currentFolder} -> ${item.expectedFolder} | destino ${item.targetPath}`;
  });

  const unresolvedPreview = result.unresolvedGroup.slice(0, options.verbose ? 25 : 10);
  printSection("Grupos sem pasta resolvida:", unresolvedPreview, (item) => {
    return `- ${item.name} | grupo ${item.group} | pasta atual ${item.currentFolder}`;
  });

  const noProductPreview = result.noProductExamples;
  printSection(`Arquivos sem codigo/grupo no banco (destino ${NO_PRODUCT_FOLDER}):`, noProductPreview, (item) => {
    return `- ${item.currentFolder}/${item.name}`;
  });

  if (options.report) {
    const reportPayload = {
      summary,
      moves: result.moves,
      conflicts: result.conflicts,
      unresolvedGroup: result.unresolvedGroup,
      noProductExamples: result.noProductExamples,
      errors: result.errors,
    };
    fs.mkdirSync(path.dirname(options.report), { recursive: true });
    fs.writeFileSync(options.report, JSON.stringify(reportPayload, null, 2), "utf8");
    console.log(`\nRelatorio salvo em: ${path.resolve(options.report)}`);
  }

  if (result.errors.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
