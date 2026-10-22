const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const asar = require("../src/asar");
const payload = require("../src/payload");
const patcher = require("../src/patcher");

const PRELOAD = '(()=>{"use strict";require("electron");module.exports={}})();';

// Builds an asar archive the same way Electron's tooling lays it out.
function makeArchive(files) {
  const header = { files: {} };
  const chunks = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const parts = name.split("/");
    let dir = header;
    for (const part of parts.slice(0, -1)) dir = dir.files[part] = dir.files[part] || { files: {} };
    const content = Buffer.from(text);
    dir.files[parts.at(-1)] = { size: content.length, offset: String(offset) };
    chunks.push(content);
    offset += content.length;
  }
  const archive = { header, data: Buffer.concat(chunks) };
  // Rewriting the first file with identical content yields a valid archive buffer.
  const first = Object.keys(files)[0];
  return asar.withFile(archive, first, Buffer.from(files[first]));
}

function tempInstall() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dpc-test-"));
  const file = path.join(dir, "app.asar");
  fs.writeFileSync(file, makeArchive({
    "package.json": JSON.stringify({ version: "8.0.10" }),
    "build/main.js": "console.log('main')",
    "build/preload.js": PRELOAD,
  }));
  return file;
}

test("snippet can be added and removed", () => {
  const patched = payload.addSnippet(PRELOAD);
  assert.ok(payload.isPatched(patched));
  assert.ok(patched.startsWith(PRELOAD));
  assert.strictEqual(payload.addSnippet(patched), patched, "adding twice is idempotent");
  assert.strictEqual(payload.removeSnippet(patched), PRELOAD);
});

test("generated page script is valid JavaScript", () => {
  const snippet = payload.buildSnippet();
  const match = snippet.match(/executeJavaScript\(("(?:[^"\\]|\\.)*")\)/);
  assert.ok(match, "executeJavaScript call found");
  assert.doesNotThrow(() => new Function(JSON.parse(match[1])));
  assert.doesNotThrow(() => new Function("require", snippet));
});

test("install patches preload only, uninstall restores the original bytes", () => {
  const file = tempInstall();
  const original = fs.readFileSync(file);

  patcher.install(file);
  const archive = asar.read(file);
  assert.ok(payload.isPatched(asar.readFile(archive, "build/preload.js").toString()));
  assert.strictEqual(asar.readFile(archive, "build/main.js").toString(), "console.log('main')");
  assert.ok(fs.existsSync(`${file}.pitch-changer-backup`));

  const again = patcher.install(file);
  assert.strictEqual(again.updated, true);
  assert.strictEqual(fs.statSync(file).size, fs.readFileSync(file).length);

  const result = patcher.uninstall(file);
  assert.strictEqual(result.changed, true);
  assert.deepStrictEqual(fs.readFileSync(file), original);
  assert.ok(!fs.existsSync(`${file}.pitch-changer-backup`));
});

test("uninstall without backup strips the snippet", () => {
  const file = tempInstall();
  patcher.install(file);
  fs.rmSync(`${file}.pitch-changer-backup`);
  patcher.uninstall(file);
  const preload = asar.readFile(asar.read(file), "build/preload.js").toString();
  assert.strictEqual(preload, PRELOAD);
});
