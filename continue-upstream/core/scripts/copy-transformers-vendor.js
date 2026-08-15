import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const coreRoot = path.resolve(path.dirname(scriptPath), "..");
const sourcePath = path.join(
  coreRoot,
  "node_modules",
  "@xenova",
  "transformers",
);
const destinationPath = path.join(
  coreRoot,
  "vendor",
  "modules",
  "@xenova",
  "transformers",
);
const requiredEntryPoint = path.join("src", "transformers.js");

export function copyTransformersVendor() {
  const sourceEntryPoint = path.join(sourcePath, requiredEntryPoint);
  if (!fs.existsSync(sourceEntryPoint)) {
    throw new Error(
      `Transformers.js dependency was not found at ${sourceEntryPoint}. Install core dependencies before preparing the vendor directory.`,
    );
  }

  fs.rmSync(destinationPath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.cpSync(sourcePath, destinationPath, {
    recursive: true,
    force: true,
    dereference: true,
  });

  const destinationEntryPoint = path.join(destinationPath, requiredEntryPoint);
  if (!fs.existsSync(destinationEntryPoint)) {
    throw new Error(
      `Transformers.js vendor entry point was not created at ${destinationEntryPoint}.`,
    );
  }

  console.log(
    `[info] Prepared Transformers.js vendor package at ${destinationPath}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    copyTransformersVendor();
  } catch (error) {
    console.error(`[error] ${error.message}`);
    process.exitCode = 1;
  }
}
