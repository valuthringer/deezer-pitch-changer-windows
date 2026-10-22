// Version of this copy of the pitch changer. `build` is set by scripts/build.js (the GitHub
// Actions run number for released executables, 0 when running from the sources).
const { version } = require("../package.json");

const build = 0;

// Running as the built executable (a Node.js single executable application).
function isPackaged() {
  try {
    return require("node:sea").isSea();
  } catch {
    return false; // Node.js older than 20.12
  }
}

module.exports = {
  version,
  build,
  label: build ? `${version}+${build}` : version,
  repo: "valuthringer/deezer-pitch-changer-windows",
  packaged: isPackaged(),
};
