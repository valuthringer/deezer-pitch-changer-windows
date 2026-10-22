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

function locate(customDir) {
  const dirs = customDir ? [path.resolve(customDir)] : candidateDirs();
  for (const dir of dirs) {
    const asar = path.join(dir, "resources", "app.asar");
    if (fs.existsSync(path.join(dir, EXE_NAME)) && fs.existsSync(asar)) {
      return { dir, exe: path.join(dir, EXE_NAME), asar };
    }
  }
  const searched = dirs.map((d) => `  - ${d}`).join("\n");
  throw new Error(`Deezer Desktop introuvable. Dossiers cherchés :\n${searched}\nIndique le dossier avec --path "C:\\...\\deezer-desktop".`);
}

// PIDs of the Deezer processes started from this install (other copies are left alone).
function processes(exe) {
  const script = `Get-CimInstance Win32_Process -Filter "Name='${EXE_NAME}'" | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)" }`;
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  const target = path.resolve(exe).toLowerCase();
  return out
    .split(/\r?\n/)
    .map((line) => line.trim().split("|"))
    .filter(([pid, file]) => pid && file && path.resolve(file).toLowerCase() === target)
    .map(([pid]) => pid);
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
      execFileSync("taskkill", [...(force ? ["/F"] : []), ...pids], { stdio: "ignore" });
    } catch {
      // Already gone, or refused a graceful close.
    }
  };
  kill(false);
  for (let i = 0; i < 20 && isRunning(exe); i++) await sleep(250);
  if (isRunning(exe)) kill(true);
  for (let i = 0; i < 20 && isRunning(exe); i++) await sleep(250);
  if (isRunning(exe)) throw new Error("Impossible de fermer Deezer. Ferme-le manuellement (y compris depuis la zone de notification) puis relance.");
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

module.exports = { locate, isRunning, stop, launch };
