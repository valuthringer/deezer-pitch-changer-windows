// Runs hidden from logon (see setup.js): re-applies the patch when a Deezer update replaced
// app.asar, and installs the new versions of the pitch changer published on GitHub.
const fs = require("fs");
const net = require("net");
const deezer = require("./deezer");
const info = require("./build-info");
const patcher = require("./patcher");
const setup = require("./setup");
const updater = require("./updater");
const { errorMessage } = require("./ui");

const TICK = 10 * 1000;
const SETTLE = 15 * 1000; // app.asar left unchanged this long: Deezer's installer is done with it
const FRESH = 90 * 1000; // Deezer running this soon after its update: restarted by its updater
const WAIT_CHECK = 60 * 1000; // how often to look whether Deezer was closed, when waiting for it
const RETRY = 60 * 1000;
const FIRST_UPDATE_CHECK = 60 * 1000;
const UPDATE_EVERY = 6 * 60 * 60 * 1000;
const UPDATE_RETRY = 30 * 60 * 1000;
const LOG_MAX = 256 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message) {
  try {
    if (fs.existsSync(setup.LOG) && fs.statSync(setup.LOG).size > LOG_MAX) fs.writeFileSync(setup.LOG, "");
    fs.appendFileSync(setup.LOG, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Logging is best effort.
  }
}

// ---------------------------------------------------------------- single instance

let busy = false;
let quitRequested = false;

// The pipe keeps a single instance running, and lets the installer ask it to quit.
function listen() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.on("data", (data) => {
        if (!String(data).includes("quit")) return;
        if (!busy) process.exit(0);
        quitRequested = true; // exits (closing the socket) once the current step is done
      });
    });
    server.once("error", () => resolve(null));
    server.listen(setup.PIPE, () => resolve(server));
  });
}

// ---------------------------------------------------------------- patch

const watch = {
  key: null, // size + mtime of app.asar when last seen
  changedAt: 0,
  checked: false,
  needsPatch: false,
  failedAt: 0,
  runningCheckAt: 0,
};

async function patchIfNeeded() {
  let app;
  let stat;
  try {
    app = deezer.locate(setup.readConfig().deezerDir || undefined);
    stat = fs.statSync(app.asar);
  } catch {
    return; // Deezer uninstalled, or being reinstalled
  }

  // Deezer's installer keeps the original file dates, so a change is detected rather than read from mtime.
  const key = `${stat.size}:${stat.mtimeMs}`;
  if (key !== watch.key) {
    watch.changedAt = watch.key === null ? 0 : Date.now();
    watch.key = key;
    watch.checked = false;
  }
  const now = Date.now();
  if (now - watch.changedAt < SETTLE) return;
  if (!watch.checked) {
    watch.needsPatch = !patcher.status(app.asar).current;
    watch.checked = true;
  }
  if (!watch.needsPatch || now - watch.failedAt < RETRY) return;

  // Deezer's updater relaunches it right after installing: restart it once more, patched.
  // Otherwise (new pitch changer version while Deezer is in use), wait until it is closed.
  const fresh = now - watch.changedAt < FRESH;
  if (!fresh && now - watch.runningCheckAt < WAIT_CHECK) return;
  watch.runningCheckAt = now;
  const running = deezer.isRunning(app.exe);
  if (running && !fresh) return;

  try {
    if (running) await deezer.stop(app.exe);
    const result = patcher.install(app.asar);
    watch.needsPatch = false;
    log(`patched Deezer ${result.version}${running ? " (restarted it)" : ""}`);
  } catch (err) {
    watch.failedAt = Date.now();
    log(`patch failed: ${errorMessage(err)}`);
  }
  if (running) deezer.launch(app.exe);
}

// ---------------------------------------------------------------- self-update

async function updateIfAvailable(server) {
  if (!info.packaged || !info.build) return;
  setup.cleanupOldFiles();
  const release = await updater.latestRelease();
  if (!release || release.build <= info.build) return;
  log(`downloading ${release.name}`);
  setup.writeExecutables(await updater.download(release));
  log(`installed ${release.name}, restarting`);
  // The new version patches Deezer again with its own scripts.
  await new Promise((resolve) => server.close(resolve));
  setup.startBackground();
  process.exit(0);
}

// ---------------------------------------------------------------- main loop

async function run() {
  let server = null;
  // After a self-update, the previous version may still be exiting.
  for (let i = 0; i < 10 && !server; i++) {
    server = await listen();
    if (!server) await sleep(1000);
  }
  if (!server) return; // already running

  setup.cleanupOldFiles();
  if (setup.readConfig().registered !== info.label) {
    // Keeps the version shown in Windows' installed apps in sync after a self-update.
    try {
      setup.register();
      setup.writeConfig({ registered: info.label });
    } catch (err) {
      log(`registration failed: ${errorMessage(err)}`);
    }
  }
  log(`started v${info.label}`);

  let nextUpdateCheck = Date.now() + FIRST_UPDATE_CHECK;
  for (;;) {
    busy = true;
    try {
      await patchIfNeeded();
    } catch (err) {
      log(`error: ${errorMessage(err)}`);
    }
    if (Date.now() >= nextUpdateCheck) {
      try {
        nextUpdateCheck = Date.now() + UPDATE_EVERY;
        await updateIfAvailable(server);
      } catch (err) {
        nextUpdateCheck = Date.now() + UPDATE_RETRY;
        log(`update check failed: ${errorMessage(err)}`);
      }
    }
    busy = false;
    if (quitRequested) process.exit(0);
    await sleep(TICK);
  }
}

module.exports = { run };
