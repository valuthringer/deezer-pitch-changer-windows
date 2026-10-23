// Microsoft Store version of Deezer: its files can't be modified, so the pitch changer is added to
// each running Deezer instead. Node.js can open the inspector of another Node.js process (here
// Deezer's main process, Electron being built on Node.js); through it, the same snippet as the
// patch (payload.js) is registered as a preload script of Deezer's sessions, then the inspector
// is closed again.
const fs = require("fs");
const path = require("path");
const payload = require("./payload");

const PRELOAD_FILE = "deezer-pitch-changer-preload.js";
const INSPECTOR = "http://127.0.0.1:9229"; // where a process asked to open its inspector listens

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs inside Deezer's main process (sent as source, so it must be self-contained).
function hook(snippet, expectedPid) {
  // Port 9229 already used by another Node.js process: Deezer couldn't open its inspector.
  if (process.pid !== expectedPid) return "wrong-process";
  // `require` only exists while this is evaluated (it comes from the debugger console): get
  // every module now. An exception thrown later, in a callback, would make Deezer quit.
  const { app, session, webContents } = require("electron");
  const fs = require("fs");
  const path = require("path");
  const inspector = require("inspector");
  const ID = "deezer-pitch-changer";
  const file = path.join(app.getPath("userData"), "deezer-pitch-changer-preload.js");
  const safely = (fn) => (...args) => {
    try {
      fn(...args);
    } catch (err) {
      console.error("[deezer-pitch-changer]", err);
    }
  };

  const register = (ses) => {
    if (ses.registerPreloadScript) {
      if (!ses.getPreloadScripts().some((p) => p.id === ID)) ses.registerPreloadScript({ type: "frame", id: ID, filePath: file });
    } else if (!ses.getPreloads().includes(file)) {
      ses.setPreloads([...ses.getPreloads(), file]); // Electron < 35
    }
  };

  const run = () => {
    fs.writeFileSync(file, snippet);
    if (!global.__deezerPitchChangerHooked) {
      global.__deezerPitchChangerHooked = true;
      app.on("session-created", safely(register));
    }
    register(session.defaultSession);
    // A page loaded before this ran doesn't have it: reload it (Deezer has just started).
    const ensure = async (wc) => {
      if (wc.isLoading()) await new Promise((resolve) => wc.once("did-stop-loading", resolve));
      if (wc.isDestroyed() || !/^https:\/\/([\w-]+\.)*deezer\.com\//.test(wc.getURL())) return;
      register(wc.session);
      const present = await wc.executeJavaScript("!!window.__deezerPitchChanger").catch(() => true);
      if (!present) wc.reload();
    };
    for (const wc of webContents.getAllWebContents()) ensure(wc).catch(() => {});
  };
  if (app.isReady()) run();
  else app.whenReady().then(safely(run));

  // The inspector was only opened to run this: close it once we are disconnected.
  setTimeout(safely(() => inspector.close()), 2000);
  return "ok";
}

// Minimal Chrome DevTools Protocol client over the inspector's WebSocket.
async function connect() {
  let targets = null;
  for (let i = 0; i < 25 && !targets; i++) {
    try {
      targets = await (await fetch(`${INSPECTOR}/json/list`)).json();
    } catch {
      await sleep(200); // the inspector takes a moment to start
    }
  }
  const target = targets && targets.find((t) => t.webSocketDebuggerUrl);
  if (!target) throw new Error("Deezer's inspector didn't open");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("couldn't connect to Deezer's inspector"));
  });
  let lastId = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (pending.has(message.id)) pending.get(message.id)(message);
    pending.delete(message.id);
  };
  const call = (method, params) => new Promise((resolve) => {
    pending.set(++lastId, resolve);
    ws.send(JSON.stringify({ id: lastId, method, params }));
  });
  return { ws, call };
}

// Adds the pitch changer to the running Store Deezer whose main process is `pid`.
async function inject(pid) {
  process._debugProcess(pid); // Node.js's way to make another process open its inspector
  const { ws, call } = await connect();
  try {
    const expression = `(${hook.toString()})(${JSON.stringify(payload.buildSnippet())}, ${pid})`;
    // includeCommandLineAPI provides `require`, as in a debugger console.
    const res = await call("Runtime.evaluate", { expression, includeCommandLineAPI: true, returnByValue: true });
    if (res.error) throw new Error(res.error.message);
    if (res.result.exceptionDetails) throw new Error(res.result.exceptionDetails.exception.description);
    const outcome = res.result.result.value;
    if (outcome === "wrong-process") throw new Error("port 9229 is used by another program, Deezer's inspector couldn't open");
  } finally {
    ws.close();
  }
}

const preloadPath = (store) => path.join(store.userData, PRELOAD_FILE);

function hasPreload(store) {
  return fs.existsSync(preloadPath(store));
}

function writePreload(store) {
  fs.mkdirSync(store.userData, { recursive: true });
  fs.writeFileSync(preloadPath(store), payload.buildSnippet());
}

// Removes the preload script file written into the Store Deezer's data folder.
function removePreload(store) {
  fs.rmSync(preloadPath(store), { force: true });
}

module.exports = { hook, inject, hasPreload, writePreload, removePreload };
