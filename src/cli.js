#!/usr/bin/env node
// deezer-pitch-changer: adds speed / pitch controls to the Deezer desktop app on Windows.
const readline = require("readline");
const deezer = require("./deezer");
const patcher = require("./patcher");
const { version } = require("../package.json");

const USAGE = `deezer-pitch-changer v${version}

Usage : node src/cli.js <commande> [options]

Commandes :
  install     Injecte le pitch changer dans Deezer (refaire après chaque mise à jour de Deezer)
  uninstall   Restaure Deezer d'origine
  status      Affiche l'état de l'installation

Options :
  --path <dossier>   Dossier d'installation de Deezer (détecté automatiquement sinon)
  --yes, -y          Ferme Deezer sans demander s'il est ouvert
  --no-launch        Ne relance pas Deezer à la fin
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
    else throw new Error(`Argument inconnu : ${arg}`);
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
      answered = /^(o|oui|y|yes)?$/i.test(answer.trim());
      rl.close();
    });
  });
}

// Deezer must be closed while app.asar is rewritten. Returns true if it was running.
async function ensureClosed(app, opts) {
  if (!deezer.isRunning(app.exe)) return false;
  if (!opts.yes && !(await ask("Deezer est ouvert et doit être fermé. Le fermer maintenant ? [O/n] "))) {
    throw new Error("Annulé : ferme Deezer puis relance la commande.");
  }
  console.log("Fermeture de Deezer…");
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
  console.log(`Deezer : ${app.dir}`);

  switch (opts.command) {
    case "status": {
      const s = patcher.status(app.asar);
      console.log(`Version de Deezer : ${s.version}`);
      console.log(`Pitch changer     : ${s.patched ? "installé" : "non installé"}`);
      console.log(`Sauvegarde        : ${s.backupVersion ? `oui (Deezer ${s.backupVersion})` : "non"}`);
      console.log(`Deezer ouvert     : ${deezer.isRunning(app.exe) ? "oui" : "non"}`);
      return;
    }
    case "install": {
      await ensureClosed(app, opts);
      const result = patcher.install(app.asar);
      console.log(result.updated
        ? `Pitch changer mis à jour (Deezer ${result.version}).`
        : `Pitch changer installé (Deezer ${result.version}). Sauvegarde : app.asar.pitch-changer-backup`);
      console.log("Dans Deezer : bouton « Pitch » en bas à droite, ou Alt+P.");
      break;
    }
    case "uninstall": {
      await ensureClosed(app, opts);
      const result = patcher.uninstall(app.asar);
      console.log(result.changed ? `Deezer ${result.version} restauré d'origine.` : "Le pitch changer n'était pas installé.");
      break;
    }
    default:
      throw new Error(`Commande inconnue : ${opts.command}\n\n${USAGE}`);
  }

  if (opts.launch) {
    console.log("Lancement de Deezer…");
    deezer.launch(app.exe);
  }
}

main().catch((err) => {
  const code = err && err.code;
  if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
    console.error(`\nErreur : fichier verrouillé ou accès refusé (${code}). Vérifie que Deezer est bien fermé (zone de notification) et réessaie.`);
  } else {
    console.error(`\nErreur : ${err && err.message ? err.message : err}`);
  }
  process.exitCode = 1;
});
