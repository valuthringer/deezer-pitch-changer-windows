const fs = require("fs");
const deezer = require("./deezer");
const info = require("./build-info");
const patcher = require("./patcher");
const setup = require("./setup");
const store = require("./store");
const updater = require("./updater");
const { errorMessage } = require("./ui");

const LOG_MAX = 256 * 1024;
const STORE_START_WAIT = 30;
const STORE_ATTEMPTS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message) {
  try {
    if (fs.existsSync(setup.LOG) && fs.statSync(setup.LOG).size > LOG_MAX) fs.writeFileSync(setup.LOG, "");
    fs.appendFileSync(setup.LOG, `${new Date().toISOString()} ${message}\n`);
  } catch {
    return;
  }
}

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function findWeb(dir) {
  if (dir) return deezer.locate(dir);
  try {
    return deezer.locate(setup.readConfig().deezerDir || undefined);
  } catch {
    return null;
  }
}

let storeCache;
function findStore(refresh = false) {
  if (storeCache === undefined || refresh) storeCache = deezer.storeInstall();
  return storeCache;
}

function installedVersion() {
  return setup.isInstalled() ? setup.readConfig().registered || null : null;
}

function state() {
  const web = findWeb();
  const storeApp = findStore(true);
  return {
    version: info.version,
    installed: setup.isInstalled(),
    installedVersion: installedVersion(),
    runningInstalled: setup.runningInstalledCopy(),
    web: web && { dir: web.dir, ...patcher.status(web.asar), running: deezer.isRunning(web.exe) },
    store: storeApp && { version: storeApp.version, running: deezer.storeMainProcesses().length > 0 },
  };
}

async function closeIfRunning(web, closeDeezer) {
  if (!deezer.isRunning(web.exe)) return false;
  if (!closeDeezer) throw failure("DEEZER_RUNNING", "Deezer is open and must be closed.");
  await deezer.stop(web.exe);
  return true;
}

async function injectStore(pid) {
  for (let attempt = 1; ; attempt++) {
    try {
      await store.inject(pid);
      log(`added to Deezer (Microsoft Store, process ${pid})`);
      return;
    } catch (err) {
      log(`couldn't add to Deezer (Microsoft Store, process ${pid}): ${errorMessage(err)}`);
      if (attempt >= STORE_ATTEMPTS) throw err;
      await sleep(2000);
    }
  }
}

function registerInstall(web) {
  setup.writeConfig({ registered: info.version });
  setup.register();
  setup.createShortcuts(web ? web.exe : null);
}

function patchIfClosed(web) {
  if (!web || deezer.isRunning(web.exe) || patcher.status(web.asar).current) return;
  try {
    const result = patcher.install(web.asar);
    log(`patched Deezer ${result.version}`);
  } catch (err) {
    log(`patch failed: ${errorMessage(err)}`);
  }
}

async function install({ closeDeezer = false, dir = null, relaunch = true } = {}) {
  if (!info.packaged) {
    throw new Error("Installing needs the built executable (npm run build). To only patch Deezer, use src/cli.js.");
  }
  const web = findWeb(dir);
  const storeApp = dir ? null : findStore();
  if (!web && !storeApp) deezer.locate();

  await setup.removeLegacyBackground();
  const wasRunning = web ? await closeIfRunning(web, closeDeezer) : false;
  if (web) patcher.install(web.asar);
  if (!setup.runningInstalledCopy()) setup.writeExecutable(fs.readFileSync(process.execPath));
  setup.writeConfig({ deezerDir: dir ? web.dir : setup.readConfig().deezerDir || null });
  registerInstall(web);
  log(`installed v${info.version}`);

  if (web && wasRunning && relaunch) deezer.launch(web.exe);
  if (storeApp) for (const pid of deezer.storeMainProcesses()) await injectStore(pid).catch(() => {});
}

async function uninstall({ closeDeezer = false, relaunch = true } = {}) {
  const web = findWeb();
  const storeApp = findStore();
  await setup.removeLegacyBackground();
  const wasRunning = web ? await closeIfRunning(web, closeDeezer) : false;
  if (web) patcher.uninstall(web.asar);
  if (storeApp) store.removePreload(storeApp);
  setup.unregister();
  setup.removeShortcuts();
  setup.removeFiles();
  if (web && wasRunning && relaunch) deezer.launch(web.exe);
  return { storeOpen: !!storeApp && deezer.storeMainProcesses().length > 0 };
}

async function launchDeezer() {
  const web = findWeb();
  if (web) {
    if (setup.isInstalled()) patchIfClosed(web);
    deezer.launch(web.exe);
    return;
  }
  const storeApp = findStore();
  if (!storeApp) deezer.locate();
  if (deezer.storeMainProcesses().length === 0) {
    deezer.launchStore(storeApp);
    for (let i = 0; i < STORE_START_WAIT && deezer.storeMainProcesses().length === 0; i++) await sleep(1000);
  }
  if (!setup.isInstalled()) return;
  for (const pid of deezer.storeMainProcesses()) await injectStore(pid);
}

let latest = null;

async function checkUpdate() {
  latest = await updater.latestRelease();
  const current = installedVersion() || info.version;
  return {
    current,
    latest: latest && latest.version,
    available: !!latest && updater.compareVersions(latest.version, current) > 0,
  };
}

async function update() {
  const release = latest || (await updater.latestRelease());
  if (!release) throw new Error("No published version was found.");
  log(`downloading ${release.name}`);
  const exe = await updater.download(release);
  await setup.removeLegacyBackground();
  setup.writeExecutable(exe);
  log(`installed ${release.name}`);
}

function afterUpdate() {
  setup.cleanupOldFiles();
  const web = findWeb();
  try {
    registerInstall(web);
  } catch (err) {
    log(`registration failed: ${errorMessage(err)}`);
  }
  patchIfClosed(web);
}

async function migrate() {
  await setup.removeLegacyBackground();
  afterUpdate();
  log(`v${info.version} no longer runs in the background`);
}

module.exports = { log, state, install, uninstall, launchDeezer, checkUpdate, update, afterUpdate, migrate };
