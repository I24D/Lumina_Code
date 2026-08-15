const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const extensionRoot = path.resolve(__dirname, "..");
const sourceBuildPath = path.resolve(
  __dirname,
  "../../../core/node_modules/sqlite3/build",
);
const bindingRelativePath = path.join("Release", "node_sqlite3.node");
const destinationRoots = [
  path.join(extensionRoot, "out", "build"),
  path.join(extensionRoot, "out"),
];

function validateNativeBinding(bindingPath) {
  if (!fs.existsSync(bindingPath)) {
    return { valid: false, error: "file does not exist" };
  }

  const result = spawnSync(
    process.execPath,
    ["-e", "require(process.argv[1])", bindingPath],
    { encoding: "utf8" },
  );

  return {
    valid: result.status === 0,
    error: (result.stderr || result.stdout || "unknown load error").trim(),
  };
}

function copySqliteBinding({ validate = false } = {}) {
  const sourceBinding = path.join(sourceBuildPath, bindingRelativePath);
  if (!fs.existsSync(sourceBuildPath) || !fs.existsSync(sourceBinding)) {
    throw new Error(
      `SQLite native binding was not found at ${sourceBinding}. Run npm install in core before building the VS Code extension.`,
    );
  }

  if (validate) {
    const sourceValidation = validateNativeBinding(sourceBinding);
    if (!sourceValidation.valid) {
      throw new Error(
        `SQLite native binding at ${sourceBinding} is invalid: ${sourceValidation.error}`,
      );
    }
  }

  for (const destinationRoot of destinationRoots) {
    const destinationBinding = path.join(destinationRoot, bindingRelativePath);
    const currentValidation = validate
      ? validateNativeBinding(destinationBinding)
      : { valid: false };

    if (currentValidation.valid) {
      console.log(
        `[info] SQLite native binding is valid at ${destinationBinding}`,
      );
      continue;
    }

    fs.mkdirSync(destinationRoot, { recursive: true });
    fs.cpSync(sourceBuildPath, destinationRoot, {
      recursive: true,
      force: true,
      dereference: true,
    });

    if (!fs.existsSync(destinationBinding)) {
      throw new Error(
        `SQLite native binding was not copied to ${destinationBinding}.`,
      );
    }

    if (validate) {
      const copiedValidation = validateNativeBinding(destinationBinding);
      if (!copiedValidation.valid) {
        throw new Error(
          `SQLite native binding copied to ${destinationBinding} is invalid: ${copiedValidation.error}`,
        );
      }
    }

    console.log(`[info] Copied SQLite native binding to ${destinationBinding}`);
  }
}

if (require.main === module) {
  try {
    copySqliteBinding({ validate: true });
  } catch (error) {
    console.error(`[error] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { copySqliteBinding, validateNativeBinding };
