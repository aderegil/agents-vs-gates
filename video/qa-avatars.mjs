// A contact sheet of floor portraits (theater-1016 QA): the humans and agents of the five AI-SDLC scenes and the
// featured runs, painted by the theater's own pixel code (no DOM), each at 6× and at the size they take on a 1080p
// floor, written as one PNG to docs/qa/theater-1016-avatars-<tag>.png.
//
//   node video/qa-avatars.mjs --tag after
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { REPO } from "./lib.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const TAG = opt("--tag", "now");
const APP = path.join(REPO, "console", "plugins", "replay", "app", "src", "engine");
const { portraitPixels } = await import(new URL(`file:///${path.join(APP, "portrait.ts").replace(/\\/g, "/")}`).href);

const SPECS = [
  { style: "human", seed: "architect", role: "architect" },
  { style: "human", seed: "product-owner", role: "product_owner" },
  { style: "human", seed: "anthropic:engineer", role: "engineer" },
  { style: "human", seed: "release-manager", role: "release_manager" },
  { style: "human", seed: "code-owner", role: "code_owner" },
  { style: "human", seed: "owner-billing", role: "code_owner" },
  { style: "human", seed: "owner-analytics", role: "code_owner" },
  { style: "human", seed: "aws:product-owner", role: "product_owner" },
  { style: "agent", seed: "code-orders", role: "code_agent", badge: "Sonnet" },
  { style: "agent", seed: "anthropic:claude-code", role: "code_agent", family: "anthropic" },
  { style: "agent", seed: "aws:architect-agent", role: "architect", family: "aws" },
  { style: "agent", seed: "kiro:spec", role: "requirements_agent", family: "kiro" },
];

const BIG = 6;
const COLS = SPECS.length;
const W = COLS * (40 * BIG + 16) + 16;
const H = 48 * BIG + 32;
const px = new Uint8Array(W * H * 4).fill(255);
for (let i = 0; i < W * H; i++) { px[i * 4] = 236; px[i * 4 + 1] = 239; px[i * 4 + 2] = 243; }
SPECS.forEach((spec, n) => {
  const g = portraitPixels(spec, {});
  const ox = 16 + n * (40 * BIG + 16);
  const oy = 16;
  for (let y = 0; y < 48; y++) for (let x = 0; x < 40; x++) {
    const i = (y * 40 + x) * 4;
    if (!g.data[i + 3]) continue;
    for (let dy = 0; dy < BIG; dy++) for (let dx = 0; dx < BIG; dx++) {
      const j = ((oy + y * BIG + dy) * W + ox + x * BIG + dx) * 4;
      px[j] = g.data[i]; px[j + 1] = g.data[i + 1]; px[j + 2] = g.data[i + 2]; px[j + 3] = 255;
    }
  }
});

function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const out = path.join(REPO, "docs", "qa", `theater-1016-avatars-${TAG}.png`);
fs.writeFileSync(out, png(W, H, px));
console.log(path.relative(REPO, out));
