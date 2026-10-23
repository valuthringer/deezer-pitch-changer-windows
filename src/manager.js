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
    return deezer.locate(setup.legacyDeezerDir() || undefined);
  } catch {
    return null;
  }
}

let storeCache;
function findStore(refresh = false) {
  if (storeCache === undefined || refresh) storeCache = deezer.storeInstall();
  return storeCache;
}

function state() {
  const web = findWeb();
  const storeApp = findStore(true);
  return {
    version: info.version,
    legacyInstall: setup.legacyInstalled(),
    web: web && { dir: web.dir, ...patcher.status(web.asar), running: deezer.isRunning(web.exe) },
    store: storeApp && {
      version: storeApp.version,
      patched: store.hasPreload(storeApp),
      running: deezer.storeMainProcesses().length > 0,
    },
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

function upgradeIfClosed(web) {
  if (!web || deezer.isRunning(web.exe)) return;
  const status = patcher.status(web.asar);
  if (!status.patched || status.current) return;
  try {
    const result = patcher.install(web.asar);
    log(`patch updated in Deezer ${result.version}`);
  } catch (err) {
    log(`patch update failed: ${errorMessage(err)}`);
  }
}

async function applyPatch({ closeDeezer = false, dir = null, relaunch = true } = {}) {
  const web = findWeb(dir);
  const storeApp = dir ? null : findStore();
  if (!web && !storeApp) deezer.locate();
  const wasRunning = web ? await closeIfRunning(web, closeDeezer) : false;
  if (web) {
    const result = patcher.install(web.asar);
    log(`patched Deezer ${result.version}`);
  }
  if (storeApp) store.writePreload(storeApp);
  if (web && wasRunning && relaunch) deezer.launch(web.exe);
  if (storeApp) for (const pid of deezer.storeMainProcesses()) await injectStore(pid).catch(() => {});
}

async function removePatch({ closeDeezer = false, dir = null, relaunch = true } = {}) {
  const web = findWeb(dir);
  const storeApp = dir ? null : findStore();
  const wasRunning = web ? await closeIfRunning(web, closeDeezer) : false;
  if (web) {
    const result = patcher.uninstall(web.asar);
    if (result.changed) log(`restored Deezer ${result.version}`);
  }
  if (storeApp) store.removePreload(storeApp);
  if (web && wasRunning && relaunch) deezer.launch(web.exe);
  return { storeOpen: !!storeApp && deezer.storeMainProcesses().length > 0 };
}

async function uninstall(options = {}) {
  await setup.removeLegacyBackground();
  const result = await removePatch(options);
  setup.removeLegacyInstall();
  return result;
}

async function launchDeezer() {
  const web = findWeb();
  if (web) {
    deezer.launch(web.exe);
    return;
  }
  const storeApp = findStore();
  if (!storeApp) deezer.locate();
  if (deezer.storeMainProcesses().length === 0) {
    deezer.launchStore(storeApp);
    for (let i = 0; i < STORE_START_WAIT && deezer.storeMainProcesses().length === 0; i++) await sleep(1000);
  }
  if (!store.hasPreload(storeApp)) return;
  for (const pid of deezer.storeMainProcesses()) await injectStore(pid);
}

let latest = null;

async function checkUpdate() {
  latest = await updater.latestRelease();
  return {
    current: info.version,
    latest: latest && latest.version,
    available: !!latest && updater.compareVersions(latest.version, info.version) > 0,
  };
}

async function update() {
  if (!info.packaged) throw new Error("Updating needs the built executable (npm run build).");
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
  try {
    setup.refreshLegacyEntry();
  } catch (err) {
    log(`couldn't update the installed apps entry: ${errorMessage(err)}`);
  }
  upgradeIfClosed(findWeb());
}

async function migrate() {
  await setup.removeLegacyBackground();
  afterUpdate();
  log(`v${info.version} no longer runs in the background`);
}

module.exports = { log, state, applyPatch, removePatch, uninstall, launchDeezer, checkUpdate, update, afterUpdate, migrate };
