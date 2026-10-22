// Builds dist/DeezerPitchChanger.exe: a Node.js single executable application, so users don't
// need Node.js. Run on Windows with Node.js 22: `npm run build` (BUILD_NUMBER sets the build).
// https://nodejs.org/api/single-executable-applications.html
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const EXE = path.join(DIST, "DeezerPitchChanger.exe");
const BUILD = Number(process.env.BUILD_NUMBER || 0);
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

// The executable runs a single script: inline every local module it requires.
function bundle(entry) {
  const modules = new Map();
  const visit = (file) => {
    const id = path.relative(ROOT, file).split(path.sep).join("/");
    if (modules.has(id)) return id;
    modules.set(id, null);
    let source = fs.readFileSync(file, "utf8").replace(/^#!.*/, "");
    if (file.endsWith(".json")) source = `module.exports = ${source};`;
    if (id === "src/build-info.js") {
      if (!/const build = 0;/.test(source)) throw new Error("build number not found in src/build-info.js");
      source = source.replace("const build = 0;", `const build = ${BUILD};`);
    }
    source = source.replace(/require\("(\.\.?\/[^"]+)"\)/g, (_, request) => {
      let target = path.resolve(path.dirname(file), request);
      if (!fs.existsSync(target)) target += ".js";
      return `__require(${JSON.stringify(visit(target))})`;
    });
    modules.set(id, source);
    return id;
  };
  const main = visit(entry);

  const definitions = [...modules].map(([id, source]) =>
    `${JSON.stringify(id)}: function (module, exports, require, __require, __filename, __dirname) {\n${source}\n},`);
  return [
    "const __modules = {",
    ...definitions,
    "};",
    "const __cache = {};",
    "function __require(id) {",
    "  if (__cache[id]) return __cache[id].exports;",
    "  const module = (__cache[id] = { exports: {} });",
    "  const dir = require(\"path\").dirname(process.execPath);",
    "  __modules[id].call(module.exports, module, module.exports, require, __require, process.execPath, dir);",
    "  return module.exports;",
    "}",
    `__require(${JSON.stringify(main)});`,
  ].join("\n");
}

// The copied node.exe carries Node's signature, which no longer matches once modified.
function removeSignature(exe) {
  const kits = path.join(process.env["ProgramFiles(x86)"] || "", "Windows Kits", "10", "bin");
  const versions = fs.existsSync(kits) ? fs.readdirSync(kits).filter((v) => /^10\./.test(v)).sort().reverse() : [];
  const signtool = versions.map((v) => path.join(kits, v, "x64", "signtool.exe")).find((p) => fs.existsSync(p));
  if (!signtool) {
    console.warn("signtool not found: the executable keeps Node's (now invalid) signature.");
    return;
  }
  execFileSync(signtool, ["remove", "/s", exe], { stdio: "inherit" });
}

async function main() {
  if (process.platform !== "win32") throw new Error("The executable must be built on Windows.");
  const { version, author, description } = require("../package.json");
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST);

  const bundlePath = path.join(DIST, "bundle.js");
  const blobPath = path.join(DIST, "sea-prep.blob");
  const configPath = path.join(DIST, "sea-config.json");
  fs.writeFileSync(bundlePath, bundle(path.join(ROOT, "src", "app.js")));
  fs.writeFileSync(configPath, JSON.stringify({
    main: bundlePath,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets: {
      "pitch-changer.js": path.join(ROOT, "src", "inject", "pitch-changer.js"),
      "pitch-worklet.js": path.join(ROOT, "src", "inject", "pitch-worklet.js"),
    },
  }, null, 2));
  execFileSync(process.execPath, ["--experimental-sea-config", configPath], { stdio: "inherit" });

  fs.copyFileSync(process.execPath, EXE);
  removeSignature(EXE);
  const fileVersion = `${version}.${BUILD}`;
  await require("rcedit")(EXE, {
    "file-version": fileVersion,
    "product-version": fileVersion,
    "version-string": {
      ProductName: "Deezer Pitch Changer",
      FileDescription: "Deezer Pitch Changer",
      CompanyName: author,
      LegalCopyright: `MIT License, ${author}`,
      OriginalFilename: path.basename(EXE),
      InternalName: "DeezerPitchChanger",
      Comments: description,
    },
  });
  await require("postject").inject(EXE, "NODE_SEA_BLOB", fs.readFileSync(blobPath), { sentinelFuse: SEA_FUSE });

  const size = (fs.statSync(EXE).size / 1024 / 1024).toFixed(1);
  console.log(`Built ${path.relative(ROOT, EXE)} (v${version}, build ${BUILD}, ${size} MB)`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { bundle };
