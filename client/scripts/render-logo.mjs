import { copyFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(root, "public");
const appDir = join(root, "app");
const markSvg = join(publicDir, "logo.svg");
const iconSvg = join(appDir, "icon.svg");

function rsvg(input, output, size) {
  execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size), "-o", output, input]);
}

function pngToIco(pngPath, icoPath, size = 48) {
  const png = execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size), iconSvg]);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size === 256 ? 0 : size, 0);
  entry.writeUInt8(size === 256 ? 0 : size, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);
  writeFileSync(icoPath, Buffer.concat([header, entry, png]));
}

rsvg(markSvg, join(publicDir, "logo.png"), 256);
rsvg(iconSvg, join(publicDir, "favicon.png"), 48);
rsvg(iconSvg, join(publicDir, "apple-icon.png"), 180);
rsvg(iconSvg, join(publicDir, "icon-512.png"), 512);
rsvg(iconSvg, join(appDir, "icon.png"), 64);
rsvg(iconSvg, join(appDir, "apple-icon.png"), 180);
copyFileSync(iconSvg, join(publicDir, "icon.svg"));
pngToIco(join(publicDir, "favicon.png"), join(publicDir, "favicon.ico"), 48);
pngToIco(join(publicDir, "favicon.png"), join(appDir, "favicon.ico"), 48);

console.log("FloyDex logo rasters written");
