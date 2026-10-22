#!/usr/bin/env node
// deezer-pitch-changer: adds speed / pitch controls to the Deezer desktop app on Windows.
const readline = require("readline");
const deezer = require("./deezer");
const patcher = require("./patcher");
const { version } = require("../package.json");

const USAGE = `deezer-pitch-changer v${version}

Usage: node src/cli.js <command> [options]

Commands:
  install     Injects the pitch changer into Deezer (run again after each Deezer update)
  uninstall   Restores the original Deezer
  status      Shows the installation status

Options:
  --path <folder>    Deezer install folder (detected automatically otherwise)
  --yes, -y          Close Deezer without asking if it is open
  --no-launch        Do not relaunch Deezer at the end
`;

function parseArgs(argv) {
  const opts = { command: null, path: null, yes: false, launch: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--path") opts.path = argv[++i];
    else if (arg === "--yes" || arg === "-y") opts.yes = true;
    else if (arg === "--no-launch") opts.launch = false;
    else if (arg === "--help" || arg === "-h") opts.command = "help";
    else if (!opts.command) opts.command = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

// Yes/no prompt; Enter means yes, a closed input (no terminal) means no.
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    let answered = false;
    rl.on("close", () => {
      if (!answered) process.stdout.write("\n");
      resolve(answered);
    });
    rl.question(question, (answer) => {
      answered = /^(y|yes)?$/i.test(answer.trim());
      rl.close();
    });
  });
}

// Deezer must be closed while app.asar is rewritten. Returns true if it was running.
async function ensureClosed(app, opts) {
  if (!deezer.isRunning(app.exe)) return false;
  if (!opts.yes && !(await ask("Deezer is open and must be closed. Close it now? [Y/n] "))) {
    throw new Error("Cancelled: close Deezer and run the command again.");
  }
  console.log("Closing Deezer…");
  await deezer.stop(app.exe);
  return true;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.command || opts.command === "help") {
    console.log(USAGE);
    return;
  }

  const app = deezer.locate(opts.path);
  console.log(`Deezer folder  : ${app.dir}`);

  switch (opts.command) {
    case "status": {
      const s = patcher.status(app.asar);
      console.log(`Deezer version : ${s.version}`);
      console.log(`Pitch changer  : ${s.patched ? "installed" : "not installed"}`);
      console.log(`Backup         : ${s.backupVersion ? `yes (Deezer ${s.backupVersion})` : "no"}`);
      console.log(`Deezer running : ${deezer.isRunning(app.exe) ? "yes" : "no"}`);
      return;
    }
    case "install": {
      await ensureClosed(app, opts);
      const result = patcher.install(app.asar);
      console.log(result.updated
        ? `Pitch changer updated (Deezer ${result.version}).`
        : `Pitch changer installed (Deezer ${result.version}). Backup: app.asar.pitch-changer-backup`);
      console.log('In Deezer: "Pitch" button at the bottom right, or Alt+P.');
      break;
    }
    case "uninstall": {
      await ensureClosed(app, opts);
      const result = patcher.uninstall(app.asar);
      console.log(result.changed ? `Deezer ${result.version} restored to its original state.` : "The pitch changer was not installed.");
      break;
    }
    default:
      throw new Error(`Unknown command: ${opts.command}\n\n${USAGE}`);
  }

  if (opts.launch) {
    console.log("Launching Deezer…");
    deezer.launch(app.exe);
  }
}

main().catch((err) => {
  const code = err && err.code;
  if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
    console.error(`\nError: file locked or access denied (${code}). Make sure Deezer is fully closed (including the notification area) and try again.`);
  } else {
    console.error(`\nError: ${err && err.message ? err.message : err}`);
  }
  process.exitCode = 1;
});
