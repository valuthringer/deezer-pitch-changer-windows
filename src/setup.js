// The executable is portable: it runs from wherever it was downloaded and replaces itself there to
// update. Versions up to 1.2 installed themselves in %LOCALAPPDATA%, with Start menu shortcuts and
// an entry in Windows' installed apps (and up to 1.1 a hidden copy started at logon): that entry
// still runs the copy there, which removes all of it.
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const info = require("./build-info");
const { author } = require("../package.json");

const LOG = path.join(os.tmpdir(), "deezer-pitch-changer.log");

const LEGACY_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), "Programs", "deezer-pitch-changer");
const LEGACY_EXE = path.join(LEGACY_DIR, "DeezerPitchChanger.exe");
const LEGACY_CONFIG = path.join(LEGACY_DIR, "config.json");
const LEGACY_BACKGROUND_EXE = path.join(LEGACY_DIR, "DeezerPitchChanger-background.exe");
const LEGACY_PIPE = "\\\\.\\pipe\\deezer-pitch-changer";
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE = "DeezerPitchChanger";
const UNINSTALL_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\DeezerPitchChanger";

const START_MENU = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs");
const SHORTCUTS = ["Deezer Pitch Changer.lnk", "Deezer with Pitch Changer.lnk"].map((name) => path.join(START_MENU, name));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// ---------------------------------------------------------------- executable

// A running executable can be renamed but not overwritten: move it aside, removed on next start.
function replaceFile(target, buffer) {
  const next = `${target}.new`;
  const old = `${target}.old`;
  fs.writeFileSync(next, buffer);
  if (fs.existsSync(target)) {
    fs.rmSync(old, { force: true });
    fs.renameSync(target, old);
  }
  fs.renameSync(next, target);
}

// Written from a buffer, which also drops the "downloaded from the internet" mark, so Windows
// doesn't show a security warning each time it is opened.
function writeExecutable(exe) {
  replaceFile(process.execPath, exe);
}

function startSelf(args) {
  spawn(process.execPath, args, { detached: true, stdio: "ignore" }).unref();
}

function cleanupOldFiles() {
  const files = [`${process.execPath}.old`, `${process.execPath}.new`];
  if (!samePath(process.execPath, LEGACY_BACKGROUND_EXE)) files.push(LEGACY_BACKGROUND_EXE);
  for (const file of files) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // Still in use by the previous version, which is exiting: removed next time.
    }
  }
}

// ---------------------------------------------------------------- versions up to 1.2

function reg(args) {
  execFileSync("reg.exe", args, { stdio: "ignore", windowsHide: true });
}

function registered() {
  try {
    reg(["query", UNINSTALL_KEY]);
    return true;
  } catch {
    return false;
  }
}

function runningLegacyCopy() {
  return samePath(path.dirname(process.execPath), LEGACY_DIR);
}

function legacyInstalled() {
  return fs.existsSync(LEGACY_DIR) || registered() || SHORTCUTS.some((file) => fs.existsSync(file));
}

function legacyDeezerDir() {
  try {
    return JSON.parse(fs.readFileSync(LEGACY_CONFIG, "utf8")).deezerDir || null;
  } catch {
    return null;
  }
}

function refreshLegacyEntry() {
  if (!runningLegacyCopy() || !registered()) return;
  reg(["add", UNINSTALL_KEY, "/v", "DisplayVersion", "/t", "REG_SZ", "/d", info.version, "/f"]);
  reg(["add", UNINSTALL_KEY, "/v", "Publisher", "/t", "REG_SZ", "/d", author, "/f"]);
}

async function removeLegacyBackground() {
  if (!fs.existsSync(LEGACY_BACKGROUND_EXE)) return;
  try {
    reg(["delete", RUN_KEY, "/v", RUN_VALUE, "/f"]);
  } catch {
    // Already removed.
  }
  if (samePath(process.execPath, LEGACY_BACKGROUND_EXE)) return;
  await new Promise((resolve) => {
    const socket = net.connect(LEGACY_PIPE);
    const timer = setTimeout(() => socket.destroy(), 10000);
    socket.on("connect", () => socket.write("quit\n"));
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await sleep(300);
  try {
    execFileSync("taskkill", ["/F", "/IM", path.basename(LEGACY_BACKGROUND_EXE)], { stdio: "ignore", windowsHide: true });
    await sleep(300);
  } catch {
    // Not running.
  }
  cleanupOldFiles();
}

function removeLegacyInstall() {
  for (const args of [["delete", RUN_KEY, "/v", RUN_VALUE, "/f"], ["delete", UNINSTALL_KEY, "/f"]]) {
    try {
      reg(args);
    } catch {
      // Already removed.
    }
  }
  for (const file of SHORTCUTS) fs.rmSync(file, { force: true });
  if (!fs.existsSync(LEGACY_DIR)) return;
  if (!runningLegacyCopy()) {
    fs.rmSync(LEGACY_DIR, { recursive: true, force: true });
    return;
  }
  // Uninstalling from Windows' settings runs the installed copy, which can't delete itself:
  // retry removing the folder every second (for up to 10 minutes) until this process has exited.
  // cmd.exe rather than PowerShell, which doesn't start as a detached process.
  const loop = `for /l %i in (1,1,600) do @(if exist "${LEGACY_DIR}" (rmdir /s /q "${LEGACY_DIR}" 2>nul & ping -n 2 127.0.0.1 >nul) else exit)`;
  spawn("cmd.exe", ["/d", "/c", `"${loop}"`], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    windowsVerbatimArguments: true, // cmd.exe has its own quoting rules
  }).unref();
}

module.exports = {
  LOG,
  writeExecutable,
  startSelf,
  cleanupOldFiles,
  runningLegacyCopy,
  legacyInstalled,
  legacyDeezerDir,
  refreshLegacyEntry,
  removeLegacyBackground,
  removeLegacyInstall,
};
