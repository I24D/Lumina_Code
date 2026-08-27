import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

const startTalkRoot = resolve(import.meta.dirname, "..");
const guiDist = resolve(
  startTalkRoot,
  "..",
  "continue-upstream",
  "gui",
  "dist",
);
const orbFrontend = resolve(startTalkRoot, "orb-frontend");

if (!existsSync(resolve(guiDist, "index.html"))) {
  throw new Error(
    `No existe ${resolve(guiDist, "index.html")}. Compila continue-upstream/gui antes de ensamblar Start Talk.`,
  );
}

// Esta comprobación evita que un cambio accidental convierta la limpieza de
// archivos obsoletos en una operación fuera de Start-talk/orb-frontend.
if (
  dirname(orbFrontend) !== startTalkRoot ||
  relative(startTalkRoot, orbFrontend) !== "orb-frontend"
) {
  throw new Error(`Destino de frontend inseguro: ${orbFrontend}`);
}

function listFiles(root, directory = root) {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return listFiles(root, absolutePath);
    }
    return [relative(root, absolutePath)];
  });
}

function removeEmptyDirectories(directory) {
  if (!existsSync(directory)) {
    return;
  }

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      removeEmptyDirectories(resolve(directory, entry.name));
    }
  }

  if (directory !== orbFrontend && readdirSync(directory).length === 0) {
    rmdirSync(directory);
  }
}

mkdirSync(orbFrontend, { recursive: true });

const sourceFiles = listFiles(guiDist);
const sourceFileSet = new Set(sourceFiles);
let copied = 0;
let removed = 0;

for (const relativePath of sourceFiles) {
  const sourcePath = resolve(guiDist, relativePath);
  const destinationPath = resolve(orbFrontend, relativePath);
  if (!destinationPath.startsWith(`${orbFrontend}${sep}`)) {
    throw new Error(`Ruta de bundle insegura: ${relativePath}`);
  }

  const alreadyMatches =
    existsSync(destinationPath) &&
    readFileSync(sourcePath).equals(readFileSync(destinationPath));
  if (alreadyMatches) {
    continue;
  }

  mkdirSync(dirname(destinationPath), { recursive: true });
  copyFileSync(sourcePath, destinationPath);
  copied += 1;
}

for (const relativePath of listFiles(orbFrontend)) {
  if (sourceFileSet.has(relativePath)) {
    continue;
  }
  unlinkSync(resolve(orbFrontend, relativePath));
  removed += 1;
}
removeEmptyDirectories(orbFrontend);

console.log(
  `Frontend de Start Talk sincronizado: ${sourceFiles.length} archivos, ${copied} actualizados, ${removed} obsoletos eliminados.`,
);
