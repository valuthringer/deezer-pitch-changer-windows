// Entry point of DeezerPitchChanger.exe (built by scripts/build.js), a portable executable.
// Double-clicked: opens its window to apply or remove the patch, open Deezer and update.
const gui = require("./gui");
const manager = require("./manager");
const { errorMessage } = require("./ui");

function parseArgs(argv) {
  const opts = { command: null, path: null, yes: false, launch: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--path") opts.path = argv[++i];
    else if (arg === "--yes" || arg === "-y") opts.yes = true;
    else if (arg === "--no-launch") opts.launch = false;
    else if (["--launch", "--updated", "--background"].includes(arg)) opts.command = arg.slice(2);
    else if (!opts.command) opts.command = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const options = { closeDeezer: true, dir: opts.path, relaunch: opts.launch };
  switch (opts.command) {
    case null:
      return gui.run();
    case "patch":
      if (!opts.yes) return gui.run();
      return manager.applyPatch(options);
    case "unpatch":
      if (!opts.yes) return gui.run();
      return manager.removePatch(options);
    case "uninstall":
      if (!opts.yes) return gui.run({ dialog: "uninstall" });
      return manager.uninstall(options);
    case "launch":
      return manager.launchDeezer();
    case "updated":
      manager.afterUpdate();
      return gui.run({ notice: "updated" });
    case "background":
      return manager.migrate();
    default:
      throw new Error(`Unknown command: ${opts.command}`);
  }
}

main().catch((err) => {
  manager.log(`error: ${errorMessage(err)}`);
  process.exitCode = 1;
});
