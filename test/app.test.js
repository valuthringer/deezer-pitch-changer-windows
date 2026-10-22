const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const deezer = require("../src/deezer");
const payload = require("../src/payload");
const { errorMessage } = require("../src/ui");
const store = require("../src/store");
const { compareVersions } = require("../src/updater");
const { bundle, withGuiSubsystem } = require("../scripts/build");

test("bundle inlines every local module and is valid JavaScript", () => {
  const source = bundle(path.join(__dirname, "..", "src", "app.js"));
  for (const id of ["src/app.js", "src/gui.js", "src/manager.js", "src/setup.js", "src/updater.js", "src/patcher.js", "package.json"]) {
    assert.ok(source.includes(JSON.stringify(id)), `${id} is bundled`);
  }
  assert.ok(!/require\("\.\.?\//.test(source), "no relative require left");
  assert.doesNotThrow(() => new Function("require", source));
});

test("the executable is marked as a GUI app", () => {
  // Minimal PE layout: e_lfanew at 0x3c, "PE\0\0", COFF header, optional header.
  const exe = Buffer.alloc(0x200);
  exe.write("MZ", 0, "latin1");
  exe.writeUInt32LE(0x80, 0x3c);
  exe.write("PE\0\0", 0x80, "latin1");
  exe.writeUInt16LE(3, 0x80 + 24 + 68); // console
  const gui = withGuiSubsystem(exe);
  assert.strictEqual(gui.readUInt16LE(0x80 + 24 + 68), 2);
  assert.strictEqual(exe.readUInt16LE(0x80 + 24 + 68), 3, "original buffer untouched");
  assert.throws(() => withGuiSubsystem(Buffer.alloc(0x200)), /not a Windows executable/);
});

test("the Microsoft Store version of Deezer is reported as unsupported", () => {
  const store = "C:\\Program Files\\WindowsApps\\Deezer.62021768415AF_7.0.0.0_x64__q7m17pa7q8kj0";
  assert.throws(() => deezer.locate(store), (err) => err.code === "DEEZER_STORE");
  assert.match(errorMessage(Object.assign(new Error(), { code: "DEEZER_STORE" })), /Microsoft Store/);
  assert.throws(() => deezer.locate(path.join(__dirname, "no-deezer-here")), (err) => err.code === "DEEZER_NOT_FOUND");
});

test("the main process of the Store Deezer is told apart from its helpers", () => {
  const exe = "C:\\Program Files\\WindowsApps\\Deezer.62021768415AF_8.0.10.0_x86__q7m17pa7q8kj0\\app\\Deezer.exe";
  assert.ok(deezer.isStoreMain(exe, `"${exe}" `));
  assert.ok(!deezer.isStoreMain(exe, `"${exe}" --type=renderer --user-data-dir=...`));
  assert.ok(!deezer.isStoreMain("C:\\Users\\me\\AppData\\Local\\Programs\\deezer-desktop\\Deezer.exe", ""));
});

test("the code sent to the Store Deezer is self-contained and checks the process", () => {
  const source = `(${store.hook.toString()})("/* snippet */", 1234)`;
  assert.doesNotThrow(() => new Function(source));
  // Run against another process id: must stop before touching Electron.
  assert.strictEqual(new Function("require", "process", `return ${source}`)(() => assert.fail("required"), { pid: 1 }), "wrong-process");
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
