// Installs the executable itself: its files in %LOCALAPPDATA%, a hidden copy started at logon
// (background.js) and an entry in Windows' installed apps to uninstall it.
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const info = require("./build-info");
const { author } = require("../package.json");

const DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), "Programs", "deezer-pitch-changer");
const EXE = path.join(DIR, "DeezerPitchChanger.exe");
const BACKGROUND_EXE = path.join(DIR, "DeezerPitchChanger-background.exe");
const CONFIG = path.join(DIR, "config.json");
const LOG = path.join(DIR, "log.txt");
const PIPE = "\\\\.\\pipe\\deezer-pitch-changer";

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE = "DeezerPitchChanger";
const UNINSTALL_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\DeezerPitchChanger";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function isInstalled() {
  return fs.existsSync(EXE);
}

function runningInstalledCopy() {
  return samePath(path.dirname(process.execPath), DIR);
}

// ---------------------------------------------------------------- config

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  } catch {
    return {};
  }
}

function writeConfig(patch) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify({ ...readConfig(), ...patch }, null, 2));
}

// ---------------------------------------------------------------- executables

// The background copy is the same program marked as a GUI app, so Windows opens no console for it.
function withGuiSubsystem(exe) {
  const buf = Buffer.from(exe);
  const pe = buf.readUInt32LE(0x3c);
  if (buf.toString("latin1", pe, pe + 4) !== "PE\0\0") throw new Error("not a Windows executable");
  // PE signature (4) + COFF header (20), then the optional header where Subsystem is at offset 68.
  buf.writeUInt16LE(2, pe + 24 + 68); // IMAGE_SUBSYSTEM_WINDOWS_GUI
  return buf;
}

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

// Written from a buffer rather than copied, which also drops the "downloaded from the internet"
// mark, so Windows doesn't show a security warning at each logon.
function writeExecutables(exe) {
  fs.mkdirSync(DIR, { recursive: true });
  replaceFile(EXE, exe);
  replaceFile(BACKGROUND_EXE, withGuiSubsystem(exe));
}

function cleanupOldFiles() {
  for (const name of fs.existsSync(DIR) ? fs.readdirSync(DIR) : []) {
    if (!/\.(old|new)$/.test(name)) continue;
    try {
      fs.rmSync(path.join(DIR, name), { force: true });
    } catch {
      // Still in use by the previous version, which is exiting: removed next time.
    }
  }
}

// ---------------------------------------------------------------- registry

function reg(args) {
  execFileSync("reg.exe", args, { stdio: "ignore", windowsHide: true });
}

function register() {
  reg(["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", `"${BACKGROUND_EXE}" --background`, "/f"]);
  const values = {
    DisplayName: "Deezer Pitch Changer",
    DisplayVersion: info.label,
    Publisher: author,
    DisplayIcon: EXE,
    InstallLocation: DIR,
    UninstallString: `"${EXE}" uninstall`,
    QuietUninstallString: `"${EXE}" uninstall --yes`,
    URLInfoAbout: `https://github.com/${info.repo}`,
  };
  for (const [name, data] of Object.entries(values)) reg(["add", UNINSTALL_KEY, "/v", name, "/t", "REG_SZ", "/d", data, "/f"]);
  for (const name of ["NoModify", "NoRepair"]) reg(["add", UNINSTALL_KEY, "/v", name, "/t", "REG_DWORD", "/d", "1", "/f"]);
  const sizeKb = Math.round((fs.statSync(EXE).size * 2) / 1024);
  reg(["add", UNINSTALL_KEY, "/v", "EstimatedSize", "/t", "REG_DWORD", "/d", String(sizeKb), "/f"]);
}

function unregister() {
  for (const args of [["delete", RUN_KEY, "/v", RUN_VALUE, "/f"], ["delete", UNINSTALL_KEY, "/f"]]) {
    try {
      reg(args);
    } catch {
      // Already removed.
    }
  }
}

// ---------------------------------------------------------------- background process

function startBackground() {
  spawn(BACKGROUND_EXE, ["--background"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

// Asks the background process to exit (through its pipe), then makes sure it is gone.
async function stopBackground() {
  await new Promise((resolve) => {
    const socket = net.connect(PIPE);
    const timer = setTimeout(() => socket.destroy(), 10000);
    socket.on("connect", () => socket.write("quit\n"));
    socket.on("error", () => {}); // not running: "close" follows
    socket.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await sleep(300);
  try {
    execFileSync("taskkill", ["/F", "/IM", path.basename(BACKGROUND_EXE)], { stdio: "ignore", windowsHide: true });
    await sleep(300);
  } catch {
    // Not running.
  }
}

function removeFiles() {
  if (!runningInstalledCopy()) {
    fs.rmSync(DIR, { recursive: true, force: true });
    return;
  }
  // Uninstalling from Windows' settings runs the installed copy, which can't delete itself:
  // retry removing the folder every second (for up to 10 minutes) until this process has exited.
  // cmd.exe rather than PowerShell, which doesn't start as a detached process.
  const loop = `for /l %i in (1,1,600) do @(if exist "${DIR}" (rmdir /s /q "${DIR}" 2>nul & ping -n 2 127.0.0.1 >nul) else exit)`;
  spawn("cmd.exe", ["/d", "/c", `"${loop}"`], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    windowsVerbatimArguments: true, // cmd.exe has its own quoting rules
  }).unref();
}

module.exports = {
  DIR,
  EXE,
  LOG,
  PIPE,
  isInstalled,
  readConfig,
  writeConfig,
  withGuiSubsystem,
  writeExecutables,
  cleanupOldFiles,
  register,
  unregister,
  startBackground,
  stopBackground,
  removeFiles,
};
