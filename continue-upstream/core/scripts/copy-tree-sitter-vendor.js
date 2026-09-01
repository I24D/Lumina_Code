import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const coreRoot = path.resolve(path.dirname(scriptPath), "..");
const sourcePath = path.join(
  coreRoot,
  "node_modules",
  "web-tree-sitter",
  "tree-sitter.wasm",
);
const destinationPath = path.join(coreRoot, "vendor", "tree-sitter.wasm");

/**
 * `core/vendor/` está en el .gitignore, así que el runtime de web-tree-sitter no
 * viaja con el repositorio. La extensión de VS Code y el binario lo copian desde
 * ahí al empaquetar, y ambos necesitan exactamente la misma versión que el
 * paquete instalado: vendorizarlo desde node_modules lo garantiza.
 */
export function copyTreeSitterVendor() {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(
      `web-tree-sitter runtime was not found at ${sourcePath}. Install core dependencies before preparing the vendor directory.`,
    );
  }

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath);

  console.log(`[info] Prepared web-tree-sitter runtime at ${destinationPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    copyTreeSitterVendor();
  } catch (error) {
    console.error(`[error] ${error.message}`);
    process.exitCode = 1;
  }
}
