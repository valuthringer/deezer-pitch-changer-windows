// Entry point of DeezerPitchChanger.exe (built by scripts/build.js).
// Double-clicked: installs itself, patches Deezer, and keeps both up to date from then on.
const fs = require("fs");
const net = require("net");
const deezer = require("./deezer");
const info = require("./build-info");
const patcher = require("./patcher");
const setup = require("./setup");
const { prompt, ask, ensureClosed, errorMessage } = require("./ui");

const USAGE = `Deezer Pitch Changer v${info.version}

Usage: DeezerPitchChanger.exe [command] [options]

Without a command, installs the pitch changer (or offers to repair / uninstall it).

Commands:
  install     Installs the pitch changer for this Windows account and patches Deezer
  uninstall   Removes it and restores the original Deezer
  status      Shows the installation status

Options:
  --path <folder>    Deezer install folder (detected automatically otherwise)
  --yes, -y          No questions: close Deezer if it is open, don't wait for Enter at the end
  --no-launch        Do not relaunch Deezer at the end
`;

function parseArgs(argv) {
  const opts = { command: null, path: null, yes: false, launch: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--path") opts.path = argv[++i];
    else if (arg === "--yes" || arg === "-y") opts.yes = true;
    else if (arg === "--no-launch") opts.launch = false;
    else if (arg === "--background") opts.command = "background";
    else if (arg === "--help" || arg === "-h") opts.command = "help";
    else if (!opts.command) opts.command = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

function locate(opts) {
  return deezer.locate(opts.path || setup.readConfig().deezerDir || undefined);
}

function backgroundRunning() {
  return new Promise((resolve) => {
    const socket = net.connect(setup.PIPE, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

// The background process is stopped while files change, and restarted if we give up halfway.
async function withBackgroundStopped(action) {
  await setup.stopBackground();
  try {
    return await action();
  } catch (err) {
    if (setup.isInstalled()) setup.startBackground();
    throw err;
  }
}

async function install(opts) {
  if (!info.packaged) {
    throw new Error("Installing needs the built executable (npm run build). To only patch Deezer, use src/cli.js.");
  }
  const app = locate(opts);
  console.log(`Deezer folder : ${app.dir}`);
  await withBackgroundStopped(async () => {
    const wasRunning = await ensureClosed(app, opts);
    const result = patcher.install(app.asar);
    setup.writeExecutables(fs.readFileSync(process.execPath));
    setup.writeConfig({ deezerDir: opts.path ? app.dir : setup.readConfig().deezerDir || null, registered: info.version });
    setup.register();
    setup.startBackground();
    console.log(`\nPitch changer v${info.version} installed (Deezer ${result.version}).`);
    console.log('In Deezer: "Pitch" button at the bottom right, or Alt+P.');
    console.log("It is re-applied automatically after Deezer updates, and updates itself.");
    if (opts.launch) deezer.launch(app.exe);
  });
}

async function uninstall(opts) {
  let app = null;
  try {
    app = locate(opts);
  } catch {
    // Deezer was uninstalled first: only remove the pitch changer.
  }
  await withBackgroundStopped(async () => {
    const wasRunning = app ? await ensureClosed(app, opts) : false;
    if (app) patcher.uninstall(app.asar);
    setup.unregister();
    setup.removeFiles();
    console.log(app ? `Pitch changer uninstalled, Deezer restored.` : "Pitch changer uninstalled.");
    if (app && wasRunning && opts.launch) deezer.launch(app.exe);
  });
}

async function status(opts) {
  const config = setup.readConfig();
  console.log(`Pitch changer  : ${setup.isInstalled() ? `installed (v${config.registered || "?"})` : "not installed"} in ${setup.DIR}`);
  console.log(`Background     : ${(await backgroundRunning()) ? "running" : "not running"}`);
  const app = locate(opts);
  const s = patcher.status(app.asar);
  console.log(`Deezer folder  : ${app.dir}`);
  console.log(`Deezer version : ${s.version}`);
  console.log(`Deezer patched : ${s.current ? "yes" : s.patched ? "yes, by another version" : "no"}`);
}

async function interactive(opts) {
  console.log(`Deezer Pitch Changer v${info.version}\n`);
  if (!setup.isInstalled()) {
    console.log("Adds speed and pitch controls to the Deezer desktop app.");
    console.log("Installed for your Windows account, it is re-applied automatically after Deezer updates.\n");
    if (await ask("Install it now? [Y/n] ")) await install(opts);
    return;
  }
  console.log(`Installed (v${setup.readConfig().registered || "?"}).\n`);
  const answer = ((await prompt("[R] Repair / reinstall   [U] Uninstall   [Enter] Quit: ")) || "").toLowerCase();
  if (answer === "r") await install(opts);
  else if (answer === "u" && (await ask("Uninstall the pitch changer and restore the original Deezer? [Y/n] "))) await uninstall(opts);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  // Double-clicked, or uninstalled from Windows' settings: keep the window open so the result can be read.
  const pause = !opts.yes && [null, "install", "uninstall"].includes(opts.command) && process.stdin.isTTY;
  try {
    switch (opts.command) {
      case null:
        await interactive(opts);
        break;
      case "background":
        await require("./background").run();
        return;
      case "install":
        await install(opts);
        break;
      case "uninstall":
        await uninstall(opts);
        break;
      case "status":
        await status(opts);
        break;
      case "help":
        console.log(USAGE);
        break;
      default:
        throw new Error(`Unknown command: ${opts.command}\n\n${USAGE}`);
    }
  } catch (err) {
    console.error(`\nError: ${errorMessage(err)}`);
    process.exitCode = 1;
  }
  if (pause) await prompt("\nPress Enter to close.");
}

main();
