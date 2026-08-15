const fs = require("fs");
const path = require("path");

const extensionRoot = path.resolve(__dirname, "..");
const sourcePath = path.join(
  extensionRoot,
  "node_modules",
  "jsdom",
  "lib",
  "jsdom",
  "living",
  "xhr",
  "xhr-sync-worker.js",
);
const destinationPath = path.join(extensionRoot, "out", "xhr-sync-worker.js");

function copyJsdomWorker() {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(
      `The jsdom XHR worker was not found at ${sourcePath}. Run npm install in extensions/vscode before building the extension.`,
    );
  }

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath);

  if (!fs.existsSync(destinationPath)) {
    throw new Error(
      `The jsdom XHR worker was not copied to ${destinationPath}.`,
    );
  }

  console.log(`[info] Copied jsdom XHR worker to ${destinationPath}`);
}

if (require.main === module) {
  try {
    copyJsdomWorker();
  } catch (error) {
    console.error(`[error] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { copyJsdomWorker };
