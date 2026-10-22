// Entry point of DeezerPitchChanger.exe (built by scripts/build.js).
// Double-clicked: opens its window to install, update or remove the pitch changer.
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
  switch (opts.command) {
    case null:
      return gui.run();
    case "install":
      if (!opts.yes) return gui.run();
      return manager.install({ closeDeezer: true, dir: opts.path, relaunch: opts.launch });
    case "uninstall":
      if (!opts.yes) return gui.run({ dialog: "uninstall" });
      return manager.uninstall({ closeDeezer: true, relaunch: opts.launch });
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
