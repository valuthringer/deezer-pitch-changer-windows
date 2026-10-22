const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const payload = require("../src/payload");
const setup = require("../src/setup");
const { compareVersions } = require("../src/updater");
const { bundle } = require("../scripts/build");

test("bundle inlines every local module and is valid JavaScript", () => {
  const source = bundle(path.join(__dirname, "..", "src", "app.js"));
  for (const id of ["src/app.js", "src/background.js", "src/setup.js", "src/updater.js", "src/patcher.js", "package.json"]) {
    assert.ok(source.includes(JSON.stringify(id)), `${id} is bundled`);
  }
  assert.ok(!/require\("\.\.?\//.test(source), "no relative require left");
  assert.doesNotThrow(() => new Function("require", source));
});

test("background copy is marked as a GUI app", () => {
  // Minimal PE layout: e_lfanew at 0x3c, "PE\0\0", COFF header, optional header.
  const exe = Buffer.alloc(0x200);
  exe.write("MZ", 0, "latin1");
  exe.writeUInt32LE(0x80, 0x3c);
  exe.write("PE\0\0", 0x80, "latin1");
  exe.writeUInt16LE(3, 0x80 + 24 + 68); // console
  const gui = setup.withGuiSubsystem(exe);
  assert.strictEqual(gui.readUInt16LE(0x80 + 24 + 68), 2);
  assert.strictEqual(exe.readUInt16LE(0x80 + 24 + 68), 3, "original buffer untouched");
  assert.throws(() => setup.withGuiSubsystem(Buffer.alloc(0x200)), /not a Windows executable/);
});

test("versions compare numerically", () => {
  assert.ok(compareVersions("1.0.1", "1.0.0") > 0);
  assert.ok(compareVersions("1.10.0", "1.9.3") > 0);
  assert.ok(compareVersions("2.0.0", "10.0.0") < 0);
  assert.strictEqual(compareVersions("1.2.3", "1.2.3"), 0);
});

test("an older patch is detected as outdated", () => {
  const preload = "module.exports={};";
  const current = payload.addSnippet(preload);
  assert.ok(payload.isCurrent(current));
  const older = current.replace("deezerPitchChanger(", "deezerPitchChanger_old(");
  assert.ok(payload.isPatched(older));
  assert.ok(!payload.isCurrent(older));
});
