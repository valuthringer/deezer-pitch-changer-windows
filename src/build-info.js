// Version of this copy of the pitch changer. Releases are published per version (tag v<version>,
// see .github/workflows/release.yml): bump it in package.json to ship an update.
const { version } = require("../package.json");

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
  repo: "valuthringer/deezer-pitch-changer-windows",
  packaged: isPackaged(),
};
