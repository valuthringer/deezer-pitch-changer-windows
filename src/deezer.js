// Locating the Deezer desktop install and managing its process (Windows).
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const EXE_NAME = "Deezer.exe";

function candidateDirs() {
  const env = process.env;
  return [
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "deezer-desktop"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "Deezer"),
    env.ProgramFiles && path.join(env.ProgramFiles, "Deezer"),
    env["ProgramFiles(x86)"] && path.join(env["ProgramFiles(x86)"], "Deezer"),
  ].filter(Boolean);
}

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function locate(customDir) {
  const dirs = customDir ? [path.resolve(customDir)] : candidateDirs();
  for (const dir of dirs) {
    if (/[\\/]WindowsApps[\\/]/i.test(dir)) throw failure("DEEZER_STORE", `${dir} is the Microsoft Store version of Deezer.`);
    const asar = path.join(dir, "resources", "app.asar");
    if (fs.existsSync(path.join(dir, EXE_NAME)) && fs.existsSync(asar)) {
      return { dir, exe: path.join(dir, EXE_NAME), asar };
    }
  }
  const searched = dirs.map((d) => `  - ${d}`).join("\n");
  throw failure("DEEZER_NOT_FOUND", `Deezer Desktop not found. Folders searched:\n${searched}\nSpecify the folder with --path "C:\\...\\deezer-desktop".`);
}

function powershell(script) {
  // windowsHide: the background process has no console, a new one would flash on screen.
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
}

// The Microsoft Store version of Deezer (an MSIX package), or null. Windows keeps its files
// read-only, so it isn't patched: store.js adds the pitch changer to it while it runs.
function storeInstall() {
  const script = [
    "$p = Get-AppxPackage -Name 'Deezer.*' | Select-Object -First 1",
    "if ($p) {",
    "  $app = (Get-AppxPackageManifest $p).Package.Applications.Application | Select-Object -First 1",
    "  [pscustomobject]@{ dir = $p.InstallLocation; family = $p.PackageFamilyName; version = $p.Version.ToString(); appId = $app.Id } | ConvertTo-Json -Compress",
    "}",
  ].join("\n");
  try {
    const out = powershell(script).trim();
    if (!out) return null;
    const pkg = JSON.parse(out);
    const exe = path.join(pkg.dir, "app", EXE_NAME);
    if (!fs.existsSync(exe)) return null;
    return {
      dir: pkg.dir,
      exe,
      version: pkg.version.replace(/\.0$/, ""),
      appUserModelId: `${pkg.family}!${pkg.appId}`,
      // Packaged apps see %APPDATA% redirected to their own folder.
      userData: path.join(process.env.LOCALAPPDATA || "", "Packages", pkg.family, "LocalCache", "Roaming", "Deezer"),
    };
  } catch {
    return null;
  }
}

function listProcesses() {
  const script = `Get-CimInstance Win32_Process -Filter "Name='${EXE_NAME}'" | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)|$($_.CommandLine)" }`;
  return powershell(script)
    .split(/\r?\n/)
    .map((line) => line.trim().split("|"))
    .filter(([pid, file]) => pid && file)
    .map(([pid, file, ...commandLine]) => ({ pid: Number(pid), file, commandLine: commandLine.join("|") }));
}

// PIDs of the Deezer processes started from this install (other copies are left alone).
function processes(exe) {
  const target = path.resolve(exe).toLowerCase();
  return listProcesses().filter((p) => path.resolve(p.file).toLowerCase() === target).map((p) => String(p.pid));
}

// Main process of a Store Deezer (helper processes have a --type= argument).
function isStoreMain(file, commandLine) {
  return /[\\/]WindowsApps[\\/]Deezer\.[^\\/]+[\\/]app[\\/]Deezer\.exe$/i.test(file) && !/\s--type=/.test(commandLine);
}

function storeMainProcesses() {
  return listProcesses().filter((p) => isStoreMain(p.file, p.commandLine)).map((p) => p.pid);
}

function isRunning(exe) {
  return processes(exe).length > 0;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function stop(exe) {
  // No /T: Electron's helper processes share the exe path and are already listed, while the
  // process tree can also contain apps Deezer opened (browser...), which must not be killed.
  const kill = (force) => {
    const pids = processes(exe).flatMap((pid) => ["/PID", pid]);
    if (pids.length === 0) return;
    try {
      execFileSync("taskkill", [...(force ? ["/F"] : []), ...pids], { stdio: "ignore", windowsHide: true });
    } catch {
      // Already gone, or refused a graceful close.
    }
  };
  kill(false);
  for (let i = 0; i < 20 && isRunning(exe); i++) await sleep(250);
  if (isRunning(exe)) kill(true);
  for (let i = 0; i < 20 && isRunning(exe); i++) await sleep(250);
  if (isRunning(exe)) throw new Error("Could not close Deezer. Close it manually (including from the notification area) and try again.");
  // Give Windows a moment to release the file handles on app.asar.
  await sleep(500);
}

function launch(exe) {
  // Inherited from editors built on Electron (VS Code...); would start Deezer as a bare Node runtime.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(exe, [], { detached: true, stdio: "ignore", env });
  child.unref();
}

// A packaged app is started through its app id, so that it runs as part of its package.
function launchStore(store) {
  spawn("explorer.exe", [`shell:AppsFolder\\${store.appUserModelId}`], { detached: true, stdio: "ignore" }).unref();
}

module.exports = { locate, storeInstall, storeMainProcesses, isStoreMain, isRunning, stop, launch, launchStore };
