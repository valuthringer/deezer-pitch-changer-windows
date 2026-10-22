// Builds the code appended to Deezer's preload.js, and removes it again.
const fs = require("fs");
const path = require("path");
const { version } = require("../package.json");

const BEGIN = "/* deezer-pitch-changer:begin */";
const END = "/* deezer-pitch-changer:end */";

function readInject(name) {
  return fs.readFileSync(path.join(__dirname, "inject", name), "utf8");
}

// The preload runs sandboxed in an isolated world; webFrame.executeJavaScript runs our code
// in the page's own world, before Deezer's scripts, on every page load.
function buildSnippet() {
  const pageScript = [
    "(() => {",
    readInject("pitch-changer.js"),
    `deezerPitchChanger(${JSON.stringify(readInject("pitch-worklet.js"))}, ${JSON.stringify(version)});`,
    "})();",
  ].join("\n");

  return [
    BEGIN,
    ";(() => {",
    "  try {",
    "    const { webFrame } = require(\"electron\");",
    `    webFrame.executeJavaScript(${JSON.stringify(pageScript)}).catch((err) => console.error("[deezer-pitch-changer]", err));`,
    "  } catch (err) {",
    "    console.error(\"[deezer-pitch-changer]\", err);",
    "  }",
    "})();",
    END,
  ].join("\n");
}

function isPatched(preloadSource) {
  return preloadSource.includes(BEGIN);
}

function removeSnippet(preloadSource) {
  const start = preloadSource.indexOf(BEGIN);
  if (start === -1) return preloadSource;
  const end = preloadSource.indexOf(END, start);
  if (end === -1) throw new Error("preload.js contains a broken deezer-pitch-changer block");
  return (preloadSource.slice(0, start).replace(/\n$/, "") + preloadSource.slice(end + END.length)).replace(/\n$/, "");
}

function addSnippet(preloadSource) {
  return `${removeSnippet(preloadSource)}\n${buildSnippet()}\n`;
}

module.exports = { addSnippet, removeSnippet, isPatched, buildSnippet };
