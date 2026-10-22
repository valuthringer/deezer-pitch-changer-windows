// Minimal reader/writer for Electron's asar archives, enough to replace one file.
//
// Layout: [uint32 4][uint32 headerPickleSize] then a Chromium pickle holding the JSON header
// ([uint32 payloadSize][uint32 jsonLength][json][padding to 4 bytes]), then the file data.
// File offsets in the header are relative to the start of the data.
const crypto = require("crypto");
const fs = require("fs");

const INTEGRITY_BLOCK_SIZE = 4 * 1024 * 1024;

function parse(buf) {
  if (buf.length < 16 || buf.readUInt32LE(0) !== 4) throw new Error("not an asar archive");
  const headerPickleSize = buf.readUInt32LE(4);
  const jsonLength = buf.readUInt32LE(12);
  const header = JSON.parse(buf.toString("utf8", 16, 16 + jsonLength));
  const data = buf.subarray(8 + headerPickleSize);
  return { header, data };
}

function read(archivePath) {
  try {
    return parse(fs.readFileSync(archivePath));
  } catch (err) {
    err.message = `${archivePath}: ${err.message}`;
    throw err;
  }
}

function entry(archive, filePath) {
  let node = archive.header;
  for (const part of filePath.split("/")) {
    node = node.files && node.files[part];
    if (!node) throw new Error(`${filePath} not found in archive`);
  }
  if (node.files || node.link) throw new Error(`${filePath} is not a regular file`);
  return node;
}

function readFile(archive, filePath) {
  const node = entry(archive, filePath);
  if (node.unpacked) throw new Error(`${filePath} is unpacked, not stored in the archive`);
  const offset = Number(node.offset);
  return archive.data.subarray(offset, offset + node.size);
}

function integrity(content) {
  const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
  const blocks = [];
  for (let i = 0; i < content.length; i += INTEGRITY_BLOCK_SIZE) {
    blocks.push(sha256(content.subarray(i, i + INTEGRITY_BLOCK_SIZE)));
  }
  if (blocks.length === 0) blocks.push(sha256(Buffer.alloc(0)));
  return { algorithm: "SHA256", hash: sha256(content), blockSize: INTEGRITY_BLOCK_SIZE, blocks };
}

// Returns a new archive buffer where `filePath` holds `content`. The new content is appended
// after the existing data; every other file keeps its bytes and offset.
function withFile(archive, filePath, content) {
  const header = JSON.parse(JSON.stringify(archive.header));
  const node = entry({ header }, filePath);
  if (node.unpacked) throw new Error(`${filePath} is unpacked, not stored in the archive`);
  node.offset = String(archive.data.length);
  node.size = content.length;
  node.integrity = integrity(content);

  const json = Buffer.from(JSON.stringify(header), "utf8");
  const padded = (json.length + 3) & ~3;
  const headerPickle = Buffer.alloc(8 + padded);
  headerPickle.writeUInt32LE(4 + padded, 0);
  headerPickle.writeUInt32LE(json.length, 4);
  json.copy(headerPickle, 8);

  const sizePickle = Buffer.alloc(8);
  sizePickle.writeUInt32LE(4, 0);
  sizePickle.writeUInt32LE(headerPickle.length, 4);

  return Buffer.concat([sizePickle, headerPickle, archive.data, content]);
}

module.exports = { parse, read, readFile, withFile };
