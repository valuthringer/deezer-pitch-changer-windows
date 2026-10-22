// New versions of the executable, published as GitHub releases by .github/workflows/release.yml.
const crypto = require("crypto");
const info = require("./build-info");

const ASSET = "DeezerPitchChanger.exe";
const HEADERS = { "User-Agent": "deezer-pitch-changer", Accept: "application/vnd.github+json" };

// Compares "x.y.z" versions: negative if a < b, 0 if equal, positive if a > b.
function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

// Latest published version, or null if there is none.
async function latestRelease() {
  const res = await fetch(`https://api.github.com/repos/${info.repo}/releases/latest`, { headers: HEADERS });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const release = await res.json();
  const tag = /^v(\d+\.\d+\.\d+)$/.exec(release.tag_name || "");
  const asset = (release.assets || []).find((a) => a.name === ASSET);
  if (!tag || !asset) return null;
  return {
    version: tag[1],
    name: release.name || release.tag_name,
    url: asset.browser_download_url,
    size: asset.size,
    digest: asset.digest || null, // "sha256:<hex>"
  };
}

async function download(release) {
  const res = await fetch(release.url, { headers: { "User-Agent": HEADERS["User-Agent"] } });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const exe = Buffer.from(await res.arrayBuffer());
  if (exe.length !== release.size) throw new Error(`incomplete download (${exe.length} of ${release.size} bytes)`);
  if (release.digest && release.digest.startsWith("sha256:")) {
    const hash = crypto.createHash("sha256").update(exe).digest("hex");
    if (hash !== release.digest.slice(7)) throw new Error("downloaded file doesn't match its checksum");
  }
  if (exe.toString("latin1", 0, 2) !== "MZ") throw new Error("downloaded file is not an executable");
  return exe;
}

module.exports = { compareVersions, latestRelease, download };
