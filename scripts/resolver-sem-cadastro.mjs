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
const SEM_CADASTRO_FOLDER = "SEM_CADASTRO";

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
  pnpm resolver-sem-cadastro [--apply] [--verbose]

Padrao:
  - roda em dry-run
  - trabalha apenas na pasta ${SEM_CADASTRO_FOLDER}
  - resolve a linha do produto por codigo
  - prioriza o banco; se nao houver pista no banco, usa nome exato em outra pasta

Regras:
  - se a imagem ja existir na linha correta, remove a copia de ${SEM_CADASTRO_FOLDER}
  - se nao existir, move da pasta ${SEM_CADASTRO_FOLDER} para a linha correta
  - se a linha nao puder ser inferida com seguranca, nao mexe

Opcoes:
  --apply             Aplica as alteracoes
  --verbose           Mostra mais exemplos
  --root <pasta>      Pasta raiz das imagens
  --db <arquivo>      Caminho do catalog.db
  --report <arquivo>  Salva relatorio JSON
  --help              Mostra esta ajuda
`);
}

function parseArgs(argv) {
  const out = {
    apply: false,
    verbose: false,
    root: DEFAULT_ROOT,
    db: DEFAULT_DB,
    report: null,
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
      case "--root":
        out.root = argv[i + 1] || out.root;
        i += 1;
        break;
      case "--db":
        out.db = argv[i + 1] || out.db;
        i += 1;
        break;
      case "--report":
        out.report = argv[i + 1] || null;
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

function resolveFolderFromGroup(groupName) {
  const normalized = normalizeText(groupName);
  return GROUP_FOLDER_ALIASES.get(normalized) || groupName;
}

function extractCode(fileName) {
  const stem = path.parse(fileName).name.toUpperCase();
  return (stem.match(/^\d+/) || [""])[0];
}

async function loadProducts(dbPath) {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(dbPath));
  const rows = [];
  const statement = db.prepare(`
    SELECT UPPER(TRIM(code)) AS code, TRIM(COALESCE(pgroup, '')) AS pgroup
    FROM products
    WHERE TRIM(COALESCE(pgroup, '')) <> ''
  `);

  while (statement.step()) {
    const row = statement.getAsObject();
    rows.push({
      code: String(row.code || ""),
      folder: resolveFolderFromGroup(String(row.pgroup || "")),
      group: String(row.pgroup || ""),
    });
  }

  statement.free();
  db.close();
  return rows;
}

function buildExactNameIndex(rootPath) {
  const index = new Map();
  const dirs = fs
    .readdirSync(rootPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== SEM_CADASTRO_FOLDER && entry.name !== "LANCAMENTOS");

  for (const dir of dirs) {
    const folderPath = path.join(rootPath, dir.name);
    for (const file of fs.readdirSync(folderPath, { withFileTypes: true })) {
      if (!file.isFile()) {
        continue;
      }
      const current = index.get(file.name) || [];
      current.push(dir.name);
      index.set(file.name, current);
    }
  }

  return index;
}

function inferFromDb(code, productRows) {
  if (!code) {
    return null;
  }

  const exact = productRows.filter((row) => row.code === code);
  if (exact.length === 1) {
    return {
      folder: exact[0].folder,
      group: exact[0].group,
      method: "db_exact",
      prefix: code,
      matches: 1,
    };
  }

  for (let len = code.length - 1; len >= 6; len -= 1) {
    const prefix = code.slice(0, len);
    const rows = productRows.filter((row) => row.code.startsWith(prefix));
    if (rows.length === 0) {
      continue;
    }

    const folders = [...new Set(rows.map((row) => row.folder))];
    if (folders.length !== 1) {
      continue;
    }

    // Mantem a inferencia restrita a familias bem proximas.
    const enoughEvidence = rows.length >= 2 || len >= code.length - 1;
    if (!enoughEvidence) {
      continue;
    }

    return {
      folder: folders[0],
      group: rows[0].group,
      method: "db_family",
      prefix,
      matches: rows.length,
    };
  }

  return null;
}

function buildSummary(result) {
  return {
    mode: result.apply ? "apply" : "dry-run",
    root: result.root,
    db: result.db,
    scannedFiles: result.scannedFiles,
    resolvedByDb: result.resolvedByDb,
    resolvedByExactName: result.resolvedByExactName,
    movedToTarget: result.movedToTarget,
    deletedFromSemCadastro: result.deletedFromSemCadastro,
    unresolved: result.unresolved.length,
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
  const semPath = path.join(options.root, SEM_CADASTRO_FOLDER);

  if (!fs.existsSync(options.root) || !fs.statSync(options.root).isDirectory()) {
    throw new Error(`Pasta raiz invalida: ${options.root}`);
  }
  if (!fs.existsSync(options.db) || !fs.statSync(options.db).isFile()) {
    throw new Error(`Banco invalido: ${options.db}`);
  }
  if (!fs.existsSync(semPath) || !fs.statSync(semPath).isDirectory()) {
    throw new Error(`Pasta ${SEM_CADASTRO_FOLDER} nao encontrada em: ${options.root}`);
  }

  const productRows = await loadProducts(options.db);
  const exactNameIndex = buildExactNameIndex(options.root);
  const semFiles = fs.readdirSync(semPath, { withFileTypes: true }).filter((entry) => entry.isFile());

  const result = {
    ...options,
    scannedFiles: semFiles.length,
    resolvedByDb: 0,
    resolvedByExactName: 0,
    movedToTarget: 0,
    deletedFromSemCadastro: 0,
    actions: [],
    unresolved: [],
    errors: [],
  };

  for (const file of semFiles) {
    const code = extractCode(file.name);
    const dbInference = inferFromDb(code, productRows);
    const exactFolders = [...new Set(exactNameIndex.get(file.name) || [])];

    let resolution = null;
    if (dbInference) {
      result.resolvedByDb += 1;
      resolution = {
        targetFolder: dbInference.folder,
        reason: dbInference.method,
        prefix: dbInference.prefix,
        matches: dbInference.matches,
        group: dbInference.group,
      };
    } else if (exactFolders.length === 1) {
      result.resolvedByExactName += 1;
      resolution = {
        targetFolder: exactFolders[0],
        reason: "exact_name_other_folder",
        prefix: null,
        matches: 1,
        group: null,
      };
    }

    if (!resolution) {
      result.unresolved.push({
        fileName: file.name,
        code,
        exactFolders,
      });
      continue;
    }

    const sourcePath = path.join(semPath, file.name);
    const targetDir = path.join(options.root, resolution.targetFolder);
    const targetPath = path.join(targetDir, file.name);
    const action =
      fs.existsSync(targetPath) ? "delete_duplicate_from_sem_cadastro" : "move_to_target_folder";

    const item = {
      action,
      code,
      fileName: file.name,
      sourcePath,
      targetFolder: resolution.targetFolder,
      targetPath,
      reason: resolution.reason,
      prefix: resolution.prefix,
      matches: resolution.matches,
      group: resolution.group,
      exactFolders,
    };
    result.actions.push(item);

    if (!options.apply) {
      continue;
    }

    try {
      if (action === "delete_duplicate_from_sem_cadastro") {
        fs.unlinkSync(sourcePath);
        result.deletedFromSemCadastro += 1;
      } else {
        fs.mkdirSync(targetDir, { recursive: true });
        fs.renameSync(sourcePath, targetPath);
        result.movedToTarget += 1;
      }
    } catch (error) {
      result.errors.push({
        ...item,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const summary = buildSummary(result);
  console.log(JSON.stringify(summary, null, 2));

  const actionPreview = result.actions.slice(0, options.verbose ? 60 : 20);
  printSection("Acoes planejadas:", actionPreview, (item) => {
    const targetText =
      item.action === "delete_duplicate_from_sem_cadastro"
        ? `apagar de ${SEM_CADASTRO_FOLDER} porque ja existe em ${item.targetFolder}`
        : `mover para ${item.targetFolder}`;
    const reasonText =
      item.reason === "db_exact"
        ? `db exato`
        : item.reason === "db_family"
          ? `familia ${item.prefix} (${item.matches} referencias no banco)`
          : `nome exato encontrado em outra pasta`;
    return `- ${item.fileName} | ${targetText} | ${reasonText}`;
  });

  const unresolvedPreview = result.unresolved.slice(0, options.verbose ? 40 : 20);
  printSection("Arquivos que permaneceram em SEM_CADASTRO:", unresolvedPreview, (item) => {
    return `- ${item.fileName} | codigo ${item.code || "n/a"} | outras pastas com mesmo nome: ${item.exactFolders.join(", ") || "nenhuma"}`;
  });

  if (options.report) {
    const payload = {
      summary,
      actions: result.actions,
      unresolved: result.unresolved,
      errors: result.errors,
    };
    fs.mkdirSync(path.dirname(options.report), { recursive: true });
    fs.writeFileSync(options.report, JSON.stringify(payload, null, 2), "utf8");
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
