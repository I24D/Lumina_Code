const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const extensionRoot = path.resolve(__dirname, "..");
const ffmpegPackageRoot = path.resolve(
  __dirname,
  "../../../core/node_modules/ffmpeg-static",
);

function getFfmpegBinaryName(platform = process.platform) {
  return platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

function validateFfmpegBinary(binaryPath) {
  if (!fs.existsSync(binaryPath)) {
    return { valid: false, error: "file does not exist" };
  }

  const result = spawnSync(binaryPath, ["-hide_banner", "-version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();

  return {
    valid: result.status === 0 && /ffmpeg version/i.test(output),
    error: result.error?.message || output || "unknown FFmpeg load error",
  };
}

function copyFfmpegBinary({ validate = false } = {}) {
  const binaryName = getFfmpegBinaryName();
  const sourceBinary = path.join(ffmpegPackageRoot, binaryName);
  const sourceLicense = `${sourceBinary}.LICENSE`;
  const destinationBinary = path.join(extensionRoot, "out", binaryName);
  const destinationLicense = `${destinationBinary}.LICENSE`;

  if (!fs.existsSync(sourceBinary)) {
    throw new Error(
      `FFmpeg binary was not found at ${sourceBinary}. Run npm install in core before building the VS Code extension.`,
    );
  }

  if (validate) {
    const sourceValidation = validateFfmpegBinary(sourceBinary);
    if (!sourceValidation.valid) {
      throw new Error(
        `FFmpeg binary at ${sourceBinary} is invalid: ${sourceValidation.error}`,
      );
    }
  }

  const destinationValidation = validate
    ? validateFfmpegBinary(destinationBinary)
    : { valid: false };
  const filesHaveSameSize =
    destinationValidation.valid &&
    fs.statSync(destinationBinary).size === fs.statSync(sourceBinary).size;

  fs.mkdirSync(path.dirname(destinationBinary), { recursive: true });
  if (!filesHaveSameSize) {
    fs.copyFileSync(sourceBinary, destinationBinary);
    fs.chmodSync(destinationBinary, fs.statSync(sourceBinary).mode);
    console.log(`[info] Copied FFmpeg binary to ${destinationBinary}`);
  } else {
    console.log(`[info] FFmpeg binary is valid at ${destinationBinary}`);
  }

  if (fs.existsSync(sourceLicense)) {
    fs.copyFileSync(sourceLicense, destinationLicense);
  }

  if (validate) {
    const copiedValidation = validateFfmpegBinary(destinationBinary);
    if (!copiedValidation.valid) {
      throw new Error(
        `FFmpeg binary copied to ${destinationBinary} is invalid: ${copiedValidation.error}`,
      );
    }
  }

  return destinationBinary;
}

if (require.main === module) {
  try {
    copyFfmpegBinary({ validate: true });
  } catch (error) {
    console.error(`[error] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  copyFfmpegBinary,
  getFfmpegBinaryName,
  validateFfmpegBinary,
};
