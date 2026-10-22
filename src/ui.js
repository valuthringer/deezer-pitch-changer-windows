// Console prompts shared by the command line (cli.js) and the executable (app.js).
const readline = require("readline");
const deezer = require("./deezer");

// Free-text answer; null when the input is closed (no terminal).
function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    let answer = null;
    rl.on("close", () => {
      if (answer === null) process.stdout.write("\n");
      resolve(answer);
    });
    rl.question(question, (text) => {
      answer = text.trim();
      rl.close();
    });
  });
}

// Yes/no prompt; Enter means yes, a closed input means no.
async function ask(question) {
  const answer = await prompt(question);
  return answer !== null && /^(y|yes)?$/i.test(answer);
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

function errorMessage(err) {
  const code = err && err.code;
  if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
    return `File locked or access denied (${code}). Make sure Deezer is fully closed (including the notification area) and try again.`;
  }
  return err && err.message ? err.message : String(err);
}

module.exports = { prompt, ask, ensureClosed, errorMessage };
