const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const info = require("./build-info");
const manager = require("./manager");
const setup = require("./setup");
const { errorMessage } = require("./ui");

const PIPE = "\\\\.\\pipe\\deezer-pitch-changer-window";
const PROFILE = path.join(os.tmpdir(), "deezer-pitch-changer-window");
const CLOSED_GRACE = 4000;
const FIRST_CONNECTION = 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function asset(name, file) {
  if (info.packaged) return require("node:sea").getAsset(name, "utf8");
  return fs.readFileSync(file, "utf8");
}

const page = () => asset("gui.html", path.join(__dirname, "gui.html"));
const logo = () => asset("icon.svg", path.join(__dirname, "..", "assets", "icon.svg"));

function browser() {
  const env = process.env;
  const roots = [env["ProgramFiles(x86)"], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean);
  const apps = [["Microsoft", "Edge", "Application", "msedge.exe"], ["Google", "Chrome", "Application", "chrome.exe"]];
  for (const app of apps) {
    for (const root of roots) {
      const exe = path.join(root, ...app);
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

function openWindow(url) {
  const exe = browser();
  if (!exe) {
    spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  const args = [
    `--app=${url}`,
    `--user-data-dir=${PROFILE}`,
    "--window-size=520,700",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-background-mode",
  ];
  spawn(exe, args, { detached: true, stdio: "ignore" }).unref();
}

function claim(onShow) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.on("data", (data) => {
        if (String(data).includes("show")) onShow();
        socket.end();
      });
    });
    server.once("error", () => resolve(null));
    server.listen(PIPE, () => resolve(server));
  });
}

function showRunning() {
  return new Promise((resolve) => {
    const socket = net.connect(PIPE, () => socket.end("show\n", () => resolve(true)));
    socket.on("error", () => resolve(false));
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

async function run({ notice = null, dialog = null } = {}) {
  const token = crypto.randomBytes(16).toString("hex");
  let origin = null;

  let lock = null;
  for (let i = 0; i < 10 && !lock; i++) {
    lock = await claim(() => origin && openWindow(`${origin}/?t=${token}`));
    if (!lock && (await showRunning())) return;
    if (!lock) await sleep(500);
  }

  setup.cleanupOldFiles();

  const clients = new Set();
  let busy = false;
  let restarting = false;
  let exitTimer = setTimeout(() => clients.size === 0 && !busy && process.exit(0), FIRST_CONNECTION);

  const exitWhenClosed = () => {
    clearTimeout(exitTimer);
    exitTimer = setTimeout(() => {
      if (clients.size > 0) return;
      if (busy) exitWhenClosed();
      else process.exit(0);
    }, CLOSED_GRACE);
  };

  const restart = async () => {
    restarting = true;
    if (lock) await new Promise((resolve) => lock.close(resolve));
    setup.startInstalled(["--updated"]);
    setTimeout(() => process.exit(0), 500);
  };

  const exclusive = (action) => async (body) => {
    if (busy || restarting) throw Object.assign(new Error("Another operation is in progress."), { status: 409 });
    busy = true;
    try {
      return await action(body);
    } finally {
      busy = false;
    }
  };

  const routes = {
    "GET /api/state": () => manager.state(),
    "GET /api/update": () => manager.checkUpdate(),
    "POST /api/install": exclusive((body) => manager.install({ closeDeezer: !!body.closeDeezer }).then(() => ({ ok: true }))),
    "POST /api/uninstall": exclusive((body) => manager.uninstall({ closeDeezer: !!body.closeDeezer })),
    "POST /api/launch": exclusive(() => manager.launchDeezer().then(() => ({ ok: true }))),
    "POST /api/update": exclusive(async () => {
      await manager.update();
      setImmediate(restart);
      return { restarting: true };
    }),
  };

  const server = http.createServer(async (req, res) => {
    const { pathname, searchParams } = new URL(req.url, "http://127.0.0.1");
    if (req.headers.host !== `127.0.0.1:${server.address().port}`) return send(res, 403, { error: "Forbidden" });

    if (pathname === "/icon.svg") {
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "max-age=3600" });
      return res.end(logo());
    }

    if (pathname === "/" || pathname === "/events") {
      if (searchParams.get("t") !== token) return send(res, 403, { error: "Forbidden" });
      if (pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(page());
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
      res.write(": connected\n\n");
      clients.add(res);
      clearTimeout(exitTimer);
      req.on("close", () => {
        clients.delete(res);
        if (clients.size === 0) exitWhenClosed();
      });
      return;
    }

    const route = routes[`${req.method} ${pathname}`];
    if (!route) return send(res, 404, { error: "Not found" });
    if (req.headers["x-token"] !== token) return send(res, 403, { error: "Forbidden" });
    try {
      const body = req.method === "POST" ? await readBody(req) : {};
      send(res, 200, await route(body));
    } catch (err) {
      if (!err.status) manager.log(`error: ${errorMessage(err)}`);
      send(res, err.status || 500, { error: errorMessage(err), code: err.code || null });
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const query = new URLSearchParams({ t: token, ...(notice && { notice }), ...(dialog && { dialog }) });
  openWindow(`${origin}/?${query}`);
}

module.exports = { run };
