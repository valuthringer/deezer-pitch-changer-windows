// Installs / removes the pitch changer in Deezer's app.asar.
const fs = require("fs");
const asar = require("./asar");
const payload = require("./payload");

const PRELOAD = "build/preload.js";

function backupPaths(asarPath) {
  const file = `${asarPath}.pitch-changer-backup`;
  return { file, meta: `${file}.json` };
}

function describe(archive) {
  const preload = asar.readFile(archive, PRELOAD).toString("utf8");
  return {
    version: JSON.parse(asar.readFile(archive, "package.json").toString("utf8")).version,
    patched: payload.isPatched(preload),
    current: payload.isCurrent(preload),
  };
}

function readBackupMeta(asarPath) {
  const { file, meta } = backupPaths(asarPath);
  if (!fs.existsSync(file) || !fs.existsSync(meta)) return null;
  try {
    return JSON.parse(fs.readFileSync(meta, "utf8"));
  } catch {
    return null;
  }
}

function status(asarPath) {
  const info = describe(asar.read(asarPath));
  const backup = readBackupMeta(asarPath);
  return { ...info, backupVersion: backup ? backup.version : null };
}

// Writes next to the target then renames, so a failure never leaves a half-written app.asar.
function writeAtomic(target, buffer) {
  const tmp = `${target}.pitch-changer-tmp`;
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, target);
}

function withPreload(archive, transform) {
  const source = asar.readFile(archive, PRELOAD).toString("utf8");
  return asar.withFile(archive, PRELOAD, Buffer.from(transform(source), "utf8"));
}

function install(asarPath) {
  const current = asar.read(asarPath);
  const info = describe(current);
  const { file: backupFile, meta: backupMeta } = backupPaths(asarPath);

  let base = current;
  if (!info.patched) {
    // Pristine archive (first install or Deezer was updated): keep a fresh copy of it.
    fs.copyFileSync(asarPath, backupFile);
    fs.writeFileSync(backupMeta, JSON.stringify({ version: info.version, createdAt: new Date().toISOString() }, null, 2));
  } else {
    const backup = readBackupMeta(asarPath);
    if (backup && backup.version === info.version) base = asar.read(backupFile);
  }

  const patched = withPreload(base, payload.addSnippet);
  if (!describe(asar.parse(patched)).patched) throw new Error("Patch verification failed, nothing was changed.");
  writeAtomic(asarPath, patched);
  return { version: info.version, updated: info.patched };
}

function uninstall(asarPath) {
  const current = asar.read(asarPath);
  const info = describe(current);
  const { file: backupFile, meta: backupMeta } = backupPaths(asarPath);
  const backup = readBackupMeta(asarPath);

  if (!info.patched) {
    return { version: info.version, changed: false };
  }
  if (backup && backup.version === info.version && !describe(asar.read(backupFile)).patched) {
    const tmp = `${asarPath}.pitch-changer-tmp`;
    fs.copyFileSync(backupFile, tmp);
    fs.renameSync(tmp, asarPath);
  } else {
    writeAtomic(asarPath, withPreload(current, payload.removeSnippet));
  }
  fs.rmSync(backupFile, { force: true });
  fs.rmSync(backupMeta, { force: true });
  return { version: info.version, changed: true };
}

module.exports = { install, uninstall, status };
