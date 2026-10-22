// Installs the executable itself: its file in %LOCALAPPDATA%, Start menu shortcuts and an entry in
// Windows' installed apps to uninstall it.
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const info = require("./build-info");
const { author } = require("../package.json");

const DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), "Programs", "deezer-pitch-changer");
const EXE = path.join(DIR, "DeezerPitchChanger.exe");
const CONFIG = path.join(DIR, "config.json");
const LOG = path.join(DIR, "log.txt");

const LEGACY_BACKGROUND_EXE = path.join(DIR, "DeezerPitchChanger-background.exe");
const LEGACY_PIPE = "\\\\.\\pipe\\deezer-pitch-changer";
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE = "DeezerPitchChanger";
const UNINSTALL_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\DeezerPitchChanger";

const START_MENU = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs");
const APP_SHORTCUT = path.join(START_MENU, "Deezer Pitch Changer.lnk");
const LAUNCHER_SHORTCUT = path.join(START_MENU, "Deezer with Pitch Changer.lnk");

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

// Written from a buffer rather than copied, which also drops the "downloaded from the internet"
// mark, so Windows doesn't show a security warning each time it is opened.
function writeExecutable(exe) {
  fs.mkdirSync(DIR, { recursive: true });
  replaceFile(EXE, exe);
}

function startInstalled(args) {
  spawn(EXE, args, { detached: true, stdio: "ignore" }).unref();
}

function cleanupOldFiles() {
  for (const name of fs.existsSync(DIR) ? fs.readdirSync(DIR) : []) {
    if (!/\.(old|new)$/.test(name) && name !== path.basename(LEGACY_BACKGROUND_EXE)) continue;
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
  const values = {
    DisplayName: "Deezer Pitch Changer",
    DisplayVersion: info.version,
    Publisher: author,
    DisplayIcon: EXE,
    InstallLocation: DIR,
    UninstallString: `"${EXE}" uninstall`,
    QuietUninstallString: `"${EXE}" uninstall --yes`,
    URLInfoAbout: `https://github.com/${info.repo}`,
  };
  for (const [name, data] of Object.entries(values)) reg(["add", UNINSTALL_KEY, "/v", name, "/t", "REG_SZ", "/d", data, "/f"]);
  for (const name of ["NoModify", "NoRepair"]) reg(["add", UNINSTALL_KEY, "/v", name, "/t", "REG_DWORD", "/d", "1", "/f"]);
  const sizeKb = Math.round(fs.statSync(EXE).size / 1024);
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

// ---------------------------------------------------------------- shortcuts

function createShortcuts(deezerExe) {
  const quote = (text) => `'${text.replace(/'/g, "''")}'`;
  const shortcut = (file, args, icon, description) => [
    `$s = $shell.CreateShortcut(${quote(file)})`,
    `$s.TargetPath = ${quote(EXE)}`,
    `$s.Arguments = ${quote(args)}`,
    `$s.WorkingDirectory = ${quote(DIR)}`,
    `$s.IconLocation = ${quote(`${icon},0`)}`,
    `$s.Description = ${quote(description)}`,
    "$s.Save()",
  ];
  const script = [
    "$shell = New-Object -ComObject WScript.Shell",
    ...shortcut(APP_SHORTCUT, "", EXE, "Install, update or remove the Deezer pitch changer"),
    ...shortcut(LAUNCHER_SHORTCUT, "--launch", deezerExe || EXE, "Opens Deezer with the pitch changer"),
  ].join("\n");
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore", windowsHide: true });
}

function removeShortcuts() {
  for (const file of [APP_SHORTCUT, LAUNCHER_SHORTCUT]) fs.rmSync(file, { force: true });
}

// ---------------------------------------------------------------- versions up to 1.1

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
  isInstalled,
  runningInstalledCopy,
  readConfig,
  writeConfig,
  writeExecutable,
  startInstalled,
  cleanupOldFiles,
  register,
  unregister,
  createShortcuts,
  removeShortcuts,
  removeLegacyBackground,
  removeFiles,
};
