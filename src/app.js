// Entry point of DeezerPitchChanger.exe (built by scripts/build.js).
// Double-clicked: installs itself, patches Deezer, and keeps both up to date from then on.
const fs = require("fs");
const net = require("net");
const deezer = require("./deezer");
const info = require("./build-info");
const patcher = require("./patcher");
const setup = require("./setup");
const storeInjection = require("./store");
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

// The version from the website (patched) and / or the Microsoft Store one (store.js).
function findDeezer(opts) {
  let web = null;
  try {
    web = locate(opts);
  } catch (err) {
    if (opts.path || err.code !== "DEEZER_NOT_FOUND") throw err;
  }
  const store = opts.path ? null : deezer.storeInstall();
  if (!web && !store) locate(opts); // throws "not found"
  return { web, store };
}

function printDeezer({ web, store }) {
  if (web) console.log(`Deezer                 : ${web.dir}`);
  if (store) console.log(`Deezer (Microsoft Store): version ${store.version}`);
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
  const { web, store } = findDeezer(opts);
  printDeezer({ web, store });
  await withBackgroundStopped(async () => {
    let result = null;
    if (web) {
      await ensureClosed(web, opts);
      result = patcher.install(web.asar);
    }
    setup.writeExecutables(fs.readFileSync(process.execPath));
    setup.writeConfig({ deezerDir: opts.path ? web.dir : setup.readConfig().deezerDir || null, registered: info.version });
    setup.register();
    // Also adds the pitch changer to a Store Deezer that is already open.
    setup.startBackground();
    const storeOpen = store && deezer.storeMainProcesses().length > 0;

    console.log(`\nPitch changer v${info.version} installed.`);
    if (web) console.log(`- Deezer ${result.version} patched, and patched again automatically after Deezer updates.`);
    if (store) console.log(`- Deezer from the Microsoft Store: added each time it starts${storeOpen ? " (the open window reloads in a few seconds)" : ""}.`);
    console.log('In Deezer: "Pitch" button at the bottom right, or Alt+P. The pitch changer updates itself.');
    if (opts.launch && web) deezer.launch(web.exe);
    else if (opts.launch && !storeOpen) deezer.launchStore(store);
  });
}

async function uninstall(opts) {
  let found = { web: null, store: null };
  try {
    found = findDeezer(opts);
  } catch {
    // Deezer was uninstalled first: only remove the pitch changer.
  }
  const { web, store } = found;
  await withBackgroundStopped(async () => {
    const wasRunning = web ? await ensureClosed(web, opts) : false;
    if (web) patcher.uninstall(web.asar);
    if (store) storeInjection.removePreload(store);
    setup.unregister();
    setup.removeFiles();
    console.log(web ? "Pitch changer uninstalled, Deezer restored." : "Pitch changer uninstalled.");
    if (store && deezer.storeMainProcesses().length > 0) console.log("Restart Deezer to remove it from the open window.");
    if (web && wasRunning && opts.launch) deezer.launch(web.exe);
  });
}

async function status(opts) {
  const config = setup.readConfig();
  console.log(`Pitch changer  : ${setup.isInstalled() ? `installed (v${config.registered || "?"})` : "not installed"} in ${setup.DIR}`);
  console.log(`Background     : ${(await backgroundRunning()) ? "running" : "not running"}`);
  const { web, store } = findDeezer(opts);
  if (web) {
    const s = patcher.status(web.asar);
    console.log(`Deezer folder  : ${web.dir}`);
    console.log(`Deezer version : ${s.version}`);
    console.log(`Deezer patched : ${s.current ? "yes" : s.patched ? "yes, by another version" : "no"}`);
  }
  if (store) {
    console.log(`Deezer (Store) : version ${store.version}, pitch changer added by the background process when it starts`);
  }
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
