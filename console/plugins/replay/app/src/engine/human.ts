// Human portraits (v2): a 40×48 head-and-shoulders bust in hand-shaded pixel art. Every choice (skin, face shape,
// hair, features, accessories, clothes) comes from the seed through the seeded PRNG, so the same seed always paints
// the same pixels. Clothes read by role group (hoodie/tee for engineers, blazer for product and governance, vest or
// lanyard for operators). Replaces pixel-souls' 22×28 paintAvatar; the seed → person mapping is new.
import { PixelGrid, hex, inEllipse, mix, ramp, type RGB, type Ramp } from "./pixels.ts";
import { pick, rngFromSeed, type Rng } from "./rng.ts";
import { PORTRAIT_H as H, PORTRAIT_W as W, humanGroup, type HumanGroup, type IdentitySpec, type Pose } from "./identity.ts";

const CX = 20; // the vertical centre line falls between pixel columns 19 and 20

const SKINS = ["#fde3c8", "#f6d0b1", "#eab98f", "#d9a172", "#c08353", "#9a6239", "#74472a", "#4f2f1d"];
const HAIR = [
  "#1d1a1c", "#1d1a1c", "#2e211b", "#2e211b", "#4a3020", "#4a3020", "#6e4a2f", "#8c3f22", "#b8612d", "#a3804a",
  "#d8b46a", "#9a9a9e", "#d9d8d6",
];
const EYES = ["#3b2417", "#21160f", "#4a6a3f", "#3e6a96", "#6b5532", "#4d5a66"];
const DEEP_EYES = ["#3b2417", "#21160f", "#2a1a12", "#5a4126"];
const SCARVES = ["#5d3a5e", "#2f4f6b", "#5e6b3a", "#a8532e", "#3d3d4a", "#7b6a93", "#b59d72", "#1f5f63"];
const CLOTH = {
  navy: "#2c3e5c", slate: "#4a5568", charcoal: "#34373e", olive: "#5e6b3a", maroon: "#7a2e3a", teal: "#1f5f63",
  mustard: "#c39a3a", beige: "#cbb69a", heather: "#9aa0a8", cream: "#e6dfcf", denim: "#4d6f96", forest: "#2f5d46",
  rust: "#a8532e", plum: "#5d3a5e", sky: "#a9c4de", white: "#f2f1ec", black: "#26272b", khaki: "#8f8461",
};
const SHIRTS = ["#f2f1ec", "#c9dbee", "#d8d3ea", "#d6e4d2", "#efe6d2", "#e3e6ea"];

type HairStyle =
  | "buzz" | "short" | "sidepart" | "quiff" | "curly" | "afro" | "bob" | "long" | "ponytail" | "bun" | "braids"
  | "hijab" | "bald";
const HAIR_STYLES: HairStyle[] = [
  "buzz", "short", "short", "sidepart", "sidepart", "quiff", "curly", "curly", "afro", "bob", "long", "long",
  "ponytail", "bun", "braids", "hijab", "bald",
];

type Outfit = "tee" | "hoodie" | "zip" | "shirt" | "polo" | "sweater" | "turtleneck" | "cardigan" | "blazer" | "suit" | "vest";
const OUTFITS: Record<HumanGroup, Outfit[]> = {
  dev: ["hoodie", "hoodie", "tee", "tee", "zip"],
  lead: ["shirt", "polo", "sweater", "cardigan", "zip"],
  product: ["blazer", "blazer", "sweater", "turtleneck", "shirt"],
  architect: ["blazer", "turtleneck", "shirt", "sweater"],
  ops: ["vest", "vest", "polo", "zip"],
  governance: ["suit", "suit", "blazer"],
};
const OUTFIT_COLORS: Record<Outfit, (keyof typeof CLOTH)[]> = {
  tee: ["navy", "olive", "maroon", "heather", "forest", "rust", "charcoal", "mustard", "denim"],
  hoodie: ["charcoal", "heather", "navy", "forest", "maroon", "olive", "plum", "black"],
  zip: ["slate", "navy", "olive", "charcoal", "rust", "forest"],
  shirt: ["white", "sky", "white"],
  polo: ["navy", "forest", "maroon", "slate", "khaki", "white"],
  sweater: ["mustard", "forest", "maroon", "navy", "heather", "beige", "plum"],
  turtleneck: ["black", "charcoal", "cream", "olive", "maroon"],
  cardigan: ["heather", "beige", "olive", "navy", "plum"],
  blazer: ["navy", "charcoal", "beige", "slate", "khaki", "black", "plum"],
  suit: ["charcoal", "navy", "black", "slate"],
  vest: ["olive", "khaki", "navy", "charcoal", "rust"],
};

interface Face {
  cy: number;
  rx: number;
  ry: number;
  jawN: number;
}

function inFace(f: Face, px: number, py: number): boolean {
  const dy = py - f.cy;
  return inEllipse(px, py, CX, f.cy, f.rx, f.ry, dy < 0 ? 2.15 : f.jawN);
}

function weighted<T>(rng: Rng, items: readonly T[]): T {
  return pick(rng, items);
}

interface Look {
  skin: Ramp;
  hair: Ramp;
  hairStyle: HairStyle;
  eye: RGB;
  face: Face;
  side: 1 | -1;
  sideburn: number;
  browStyle: number;
  nose: number;
  mouthW: number;
  facialHair: "none" | "stubble" | "mustache" | "goatee" | "beard";
  glasses: null | { frame: RGB; round: boolean };
  earring: RGB | null;
  blush: boolean;
  lines: boolean;
  outfit: Outfit;
  cloth: Ramp;
  inner: Ramp;
  lanyard: boolean;
  tie: Ramp | null;
  scarf: Ramp;
  print: number;
}

function skinRamp(c: RGB): Ramp {
  return {
    hi: mix(c, [255, 240, 225], 0.3),
    base: c,
    mid: mix(c, [96, 36, 40], 0.2),
    lo: mix(c, [72, 24, 36], 0.36),
    line: mix(c, [40, 16, 12], 0.62),
  };
}

function chooseLook(spec: IdentitySpec, cy: number): Look {
  const rng = rngFromSeed(`human-v2:${spec.seed}`);
  const group = humanGroup(spec);
  const skinIdx = Math.floor(rng() * SKINS.length);
  const skinC = hex(SKINS[skinIdx]);
  const hairStyle = weighted(rng, HAIR_STYLES);
  let hairC = hex(pick(rng, HAIR));
  // very light hair on very light skin washes out; nudge it one step darker
  if (hairC[0] > 200 && skinC[0] > 240 && rng() < 0.5) hairC = hex("#a3804a");
  const face: Face = { cy, rx: pick(rng, [7.6, 8.0, 8.0, 8.4]), ry: pick(rng, [9.7, 10.0, 10.3]), jawN: pick(rng, [1.75, 2.0, 2.0, 2.6]) };
  const grey = hairC[0] > 140 && Math.abs(hairC[0] - hairC[2]) < 12;
  const fh = rng();
  const facialHair: Look["facialHair"] = hairStyle === "hijab" || fh < 0.62 ? "none"
    : fh < 0.72 ? "stubble" : fh < 0.8 ? "mustache" : fh < 0.88 ? "goatee" : "beard";
  const glassesP = group === "architect" ? 0.6 : 0.28;
  const glasses = rng() < glassesP
    ? { frame: hex(pick(rng, ["#1f2329", "#1f2329", "#5a3b26", "#3e4c66", "#9aa3ad", "#7a2e3a"])), round: rng() < 0.4 }
    : null;
  const earsVisible = !["bob", "long", "hijab", "afro", "braids"].includes(hairStyle);
  const earring = earsVisible && rng() < 0.3 ? hex(pick(rng, ["#e3b341", "#cfd6de"])) : null;
  const outfit = pick(rng, OUTFITS[group]);
  const clothC = hex(CLOTH[pick(rng, OUTFIT_COLORS[outfit])]);
  let innerC: RGB;
  if (outfit === "blazer" || outfit === "suit") innerC = hex(pick(rng, outfit === "suit" ? SHIRTS : [...SHIRTS, CLOTH.black, CLOTH.cream, CLOTH.heather]));
  else if (outfit === "vest" || outfit === "cardigan") innerC = hex(pick(rng, [CLOTH.white, CLOTH.heather, CLOTH.sky, CLOTH.cream, CLOTH.charcoal]));
  else if (outfit === "sweater") innerC = hex(pick(rng, SHIRTS));
  else innerC = clothC;
  const tie = outfit === "suit" && rng() < 0.6 ? ramp(hex(pick(rng, ["#7a2e3a", "#2c3e5c", "#5e6b3a", "#3d3d4a", "#8f6b2e"]))) : null;
  const lanyard = group === "ops" ? rng() < 0.75 : group === "governance" ? rng() < 0.5 : rng() < 0.12;
  return {
    skin: skinRamp(skinC),
    hair: ramp(hairC, [16, 10, 14]),
    hairStyle,
    eye: hex(skinIdx >= 4 ? pick(rng, DEEP_EYES) : pick(rng, EYES)),
    face,
    side: rng() < 0.5 ? 1 : -1,
    sideburn: pick(rng, [0, 0.8, 1.6]),
    browStyle: Math.floor(rng() * 3),
    nose: Math.floor(rng() * 3),
    mouthW: pick(rng, [4, 4, 6]),
    facialHair,
    glasses,
    earring,
    blush: rng() < 0.35,
    lines: grey,
    outfit,
    cloth: ramp(clothC),
    inner: ramp(innerC),
    lanyard,
    tie,
    scarf: ramp(hex(pick(rng, SCARVES))),
    print: Math.floor(rng() * 4),
  };
}

// ---------------------------------------------------------------------------------------------------- body
function torsoTop(dx: number): number {
  const a = Math.abs(dx);
  return 34 + Math.pow(Math.max(0, a - 4.5), 2) / 26 + (a > 15.4 ? (a - 15.4) * 1.4 : 0);
}

function inTorso(px: number, py: number): boolean {
  const dx = px - CX;
  return Math.abs(dx) <= 17.6 && py >= torsoTop(dx);
}

function clothFill(r: Ramp) {
  return (px: number, py: number): RGB => {
    const dx = px - CX;
    const a = Math.abs(dx);
    if (a > 12.4 && a < 13.4 && py > 40.5) return r.lo; // arm / body separation
    if (dx > 13.4) return py > 41 ? r.lo : r.mid;
    if (dx > 8.5) return r.mid;
    if (dx < -12.4 && py < 40) return r.hi;
    return r.base;
  };
}

function paintBody(g: PixelGrid, L: Look): void {
  const c = L.cloth;
  g.shape(inTorso, clothFill(c), c.line);
  const set = (x: number, y: number, col: RGB) => g.over(x, y, col);
  const vOpen = (py: number, top = 34, width = 3.4, slope = 0.5) => width - (py - top) * slope;
  const o = L.outfit;

  if (o === "blazer" || o === "suit") {
    // inner shirt in a V, lapels either side, two buttons
    for (let y = 33; y < H; y++) {
      for (let x = 10; x < 30; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const a = Math.abs(px - CX);
        const v = vOpen(py, 34, 3.6, 0.42);
        if (py >= 34 && a <= v) set(x, y, a > v - 1 && L.inner.base[0] > 200 ? L.inner.mid : L.inner.base);
        else if (py >= 34 && py < 43 && a <= v + 1) set(x, y, c.line);
        else if (py >= 34 && py < 42 && a <= v + 3.2) set(x, y, a <= v + 2 ? c.hi : c.base);
        else if (py >= 42 && a < 0.6) set(x, y, c.line);
      }
    }
    set(19, 44, c.line);
    set(20, 44, c.lo);
    set(19, 46, c.line);
    set(20, 46, c.lo);
    if (L.tie) {
      for (let y = 35; y < 43; y++) {
        const w = y < 37 ? 1 : y < 41 ? 1 : 0;
        for (let x = 20 - w - (y >= 37 ? 0 : 0); x <= 19 + w; x++) set(x, y, x === 19 + w ? L.tie.mid : L.tie.base);
      }
      set(19, 35, L.tie.line);
      set(20, 35, L.tie.line);
    }
    // a pocket square line on the left breast of some blazers
    if (o === "blazer" && L.print === 2) { set(11, 40, L.inner.base); set(12, 40, L.inner.base); set(13, 40, c.line); }
  } else if (o === "hoodie" || o === "zip") {
    if (o === "zip") {
      for (let y = 35; y < H; y++) set(19, y, c.line);
      for (let y = 35; y < H; y++) set(20, y, c.hi);
      set(20, 38, hex("#cfd6de"));
      set(20, 39, hex("#cfd6de"));
    } else {
      for (let y = 37; y < 42; y++) { set(17, y, L.inner.hi); set(22, y, L.inner.hi); }
      set(17, 42, c.line);
      set(22, 42, c.line);
      for (let x = 13; x <= 26; x++) set(x, 44, c.lo);
      set(12, 45, c.lo); set(27, 45, c.lo);
    }
  } else if (o === "tee") {
    if (L.print === 1) for (let x = 15; x <= 24; x++) { set(x, 40, c.hi); set(x, 41, c.hi); }
    if (L.print === 2) { for (let y = 39; y < 43; y++) for (let x = 16; x <= 23; x++) set(x, y, (x + y) % 2 ? c.hi : c.mid); }
  } else if (o === "sweater") {
    for (let x = 4; x < 36; x++) { set(x, 46, c.mid); }
  } else if (o === "cardigan" || o === "vest") {
    const inner = L.inner;
    const open = o === "vest" ? 3.2 : 2.6;
    const armless = o === "vest";
    for (let y = 33; y < H; y++) {
      for (let x = 2; x < 38; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        if (!inTorso(px, py)) continue;
        const a = Math.abs(px - CX);
        if (a < open - (py < 38 ? 0 : 0)) set(x, y, a > open - 1.2 ? inner.mid : inner.base);
        else if (a < open + 1) set(x, y, c.line);
        else if (armless && a > 12.4) set(x, y, a > 13.4 && px > CX ? inner.mid : inner.base);
        else if (armless && a > 11.4) set(x, y, c.line);
      }
    }
    if (o === "vest") {
      for (const sx of [-1, 1]) {
        for (let x = 0; x < 4; x++) set(CX + sx * 6 + (sx > 0 ? x : -x - 1), 42, c.line);
        set(CX + sx * 6 + (sx > 0 ? 0 : -1), 43, c.line);
        set(CX + sx * 9 + (sx > 0 ? 0 : -1), 43, c.line);
      }
    } else {
      for (const y of [39, 42, 45]) set(CX - 4, y, c.hi);
    }
  }
}

function paintNeck(g: PixelGrid, L: Look, f: Face): void {
  const s = L.skin;
  const o = L.outfit;
  const deep = o === "tee" || o === "hoodie" || o === "blazer" ? 2.4 : 1.4;
  g.shape(
    // a wider neck (8–9 px, was 6) that meets the collar in a soft curve
    (px, py) => (Math.abs(px - CX) <= 4.2 && py > f.cy + 4 && py < 36) || (py >= 33.5 && inEllipse(px, py, CX, 33.6, 5.4, deep)),
    (px, py) => (py < f.cy + f.ry + 2.2 ? s.lo : px - CX > 1.4 ? s.lo : s.mid),
    (_x, y) => (y >= 34 ? L.cloth.line : s.line),
  );
  if (o === "turtleneck") {
    g.shape((px, py) => Math.abs(px - CX) <= 4.6 && py > f.cy + f.ry - 1 && py < 36.5,
      (px) => (Math.floor(px) % 2 === 0 ? L.cloth.base : L.cloth.mid), L.cloth.line);
  } else if (o === "zip") {
    g.shape((px, py) => Math.abs(px - CX) <= 4.4 && py > f.cy + f.ry + 0.2 && py < 35.5 && Math.abs(px - CX) > 0.4,
      (px) => (px < CX ? L.cloth.hi : L.cloth.base), L.cloth.line);
  } else if (o === "hoodie") {
    // hood bunched behind the neck, drawn as a thick collar
    for (let y = 31; y < 37; y++) {
      for (let x = 10; x < 30; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const a = Math.abs(px - CX);
        const ring = inEllipse(px, py, CX, 34.2, 8.2, 3.2) && !inEllipse(px, py, CX, 33.6, 4.6, 2.6);
        if (ring && py > 32.6) g.set(x, y, a > 7 ? L.cloth.line : px > CX ? L.cloth.mid : L.cloth.hi);
      }
    }
  } else if (o === "shirt" || o === "polo" || o === "sweater" || o === "suit" || (o === "blazer" && L.inner.base[0] > 200)) {
    const col = o === "shirt" || o === "polo" ? L.cloth : L.inner;
    const k = col.line;
    const w = col.base;
    const l = col.mid;
    // collar points over the neck base
    g.bitmap(13, 32, [
      "...kk....kk...",
      "..kwwk..kwwk..",
      "..kwwwkkwwwk..",
      "...kwwwwwwlk..",
      "....kkwwlkk...",
      "......kk......",
    ], { k, w, l });
    if (o === "shirt") {
      for (let y = 38; y < H; y++) { g.over(19, y, col.mid); }
      for (const y of [39, 42, 45]) g.over(20, y, col.line);
    } else if (o === "polo") {
      for (let y = 37; y < 41; y++) g.over(19, y, col.mid);
      g.over(20, 38, col.line);
      g.over(20, 40, col.line);
    }
  } else if (o === "tee" || o === "cardigan" || o === "vest") {
    // ribbed crew neck
    for (let x = 14; x < 26; x++) {
      for (let y = 33; y < 38; y++) {
        const px = x + 0.5;
        const py = y + 0.5;
        if (!g.opaque(x, y)) continue;
        const onRim = !inEllipse(px, py, CX, 33.6, 4.4, o === "tee" ? 2.4 : 1.4) && inEllipse(px, py, CX, 33.6, 5.5, (o === "tee" ? 2.4 : 1.4) + 1.1);
        if (onRim && py > 33.4) g.set(x, y, o === "tee" ? L.cloth.mid : L.inner.mid);
      }
    }
  }
  if (L.lanyard) {
    const strap = hex("#4b5361");
    const pts: [number, number][] = [[16, 36], [16, 37], [17, 38], [17, 39], [18, 40], [23, 36], [23, 37], [22, 38], [22, 39], [21, 40]];
    for (const [x, y] of pts) g.over(x, y, strap);
    g.bitmap(17, 41, ["kkkkkk", "kbbbbk", "kwwwwk", "kwkkwk", "kwwwwk", "kkkkkk"],
      { k: hex("#3a404b"), b: hex("#5b6474"), w: hex("#f4f5f7") });
  }
}

// ---------------------------------------------------------------------------------------------------- head
function paintEars(g: PixelGrid, L: Look, f: Face): void {
  const s = L.skin;
  for (const sx of [-1, 1]) {
    const ex = CX + sx * (f.rx + 0.2);
    g.shape((px, py) => inEllipse(px, py, ex, f.cy + 1.3, 1.8, 2.7), (px) => ((px - ex) * sx > 0.2 ? s.base : s.mid), s.line);
    const ix = Math.floor(ex + sx * 0.2);
    g.over(ix, Math.floor(f.cy + 1), s.lo);
    g.over(ix, Math.floor(f.cy + 2), s.lo);
    if (L.earring) {
      g.set(Math.floor(ex), Math.floor(f.cy + 4.2), L.earring);
      if (L.print % 2 === 0) g.set(Math.floor(ex), Math.floor(f.cy + 5.2), L.earring);
    }
  }
}

function paintHead(g: PixelGrid, L: Look, f: Face, clip?: (px: number, py: number) => boolean): void {
  const s = L.skin;
  g.shape(
    (px, py) => inFace(f, px, py) && (!clip || clip(px, py)),
    (px, py) => {
      const dx = px - CX;
      const dy = py - f.cy;
      const edgeR = !inFace(f, px + 1.6, py);
      const edgeB = dy > f.ry * 0.45 && !inFace(f, px, py + 1.4);
      if (edgeR && dy > -f.ry * 0.7) return s.mid;
      if (edgeB) return s.mid;
      if (dx > f.rx - 3.4 && dy > 0.5 && dy < 5) return s.mid; // cheekbone hollow on the shaded side
      if (dx < -2 && dx > -f.rx + 1.4 && dy < -f.ry * 0.38 && dy > -f.ry * 0.8) return s.hi;
      if (dx < -f.rx + 3 && dx > -f.rx + 1.2 && dy > 0.2 && dy < 3.4) return s.hi;
      return s.base;
    },
    s.line,
  );
}

function paintFeatures(g: PixelGrid, L: Look, f: Face, pose: Pose): void {
  const s = L.skin;
  const cy = Math.round(f.cy);
  const lid = cy - 1;
  const lash = mix(s.line, [12, 8, 10], 0.45);
  const white: RGB = [244, 239, 232];
  const iris = L.eye;
  const pupil = mix(L.eye, [8, 6, 10], 0.65);
  const hl: RGB = [255, 255, 255];
  const expr = pose.expression ?? "neutral";

  // nose
  const n = L.nose;
  g.over(21, cy + 2, s.mid);
  g.over(21, cy + 3, s.mid);
  if (n === 1) g.over(21, cy + 1, s.mid);
  g.over(19, cy + 2, s.hi);
  g.over(19, cy + 4, s.mid);
  g.over(20, cy + 4, s.lo);
  g.over(21, cy + 4, s.lo);
  if (n === 2) { g.over(18, cy + 4, s.mid); g.over(22, cy + 4, s.mid); }

  // facial hair (under the mouth, which is drawn on top)
  const h = L.hair;
  if (L.facialHair === "stubble" || L.facialHair === "beard") {
    for (let y = cy + 2; y < H; y++) {
      for (let x = 8; x < 32; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        if (!inFace(f, px, py)) continue;
        const dx = Math.abs(px - CX);
        const jaw = py > f.cy + 4.6 || (dx > f.rx - 2.4 && py > f.cy + 1.5);
        if (!jaw) continue;
        if (L.facialHair === "stubble") { if ((x + y) % 2 === 0) g.set(x, y, mix(g.get(x, y) ?? s.base, h.base, 0.38)); }
        else g.set(x, y, dx > f.rx - 2 ? h.mid : (x + y * 2) % 5 === 0 ? h.hi : h.base);
      }
    }
    if (L.facialHair === "beard") {
      g.shape((px, py) => inFace({ ...f, ry: f.ry + 1.2, rx: f.rx - 0.2 }, px, py) && !inFace(f, px, py) && py > f.cy + 4,
        () => h.mid, h.line);
    }
  }
  const mw = L.mouthW;
  const mx0 = CX - mw / 2;
  const mx1 = CX + mw / 2 - 1;
  const my = cy + 6;
  if (L.facialHair === "mustache" || L.facialHair === "goatee" || L.facialHair === "beard") {
    for (let x = mx0 - 1; x <= mx1 + 1; x++) g.over(x, my - 1, x === mx0 - 1 || x === mx1 + 1 ? h.mid : h.base);
  }
  if (L.facialHair === "goatee") {
    for (let y = my + 2; y <= my + 4; y++) for (let x = CX - 2; x <= CX + 1; x++) g.over(x, y, y === my + 4 ? h.mid : h.base);
  }

  // mouth
  const deep = s.base[0] * 0.3 + s.base[1] * 0.59 + s.base[2] * 0.11 < 120;
  const lip = deep ? mix(s.line, [140, 56, 66], 0.28) : mix(s.lo, [110, 30, 46], 0.45);
  const lipLight = mix(s.base, [196, 96, 100], 0.22);
  if (pose.mouth === "open") {
    for (let x = mx0; x <= mx1; x++) g.over(x, my, lip);
    for (let x = mx0 + 1; x <= mx1 - 1; x++) g.over(x, my + 1, [70, 24, 32]);
    for (let x = mx0 + 1; x <= mx1 - 1; x++) g.over(x, my + 2, lipLight);
  } else if (expr === "happy") {
    for (let x = mx0; x <= mx1; x++) g.over(x, my, lip);
    g.over(mx0 - 1, my - 1, lip);
    g.over(mx1 + 1, my - 1, lip);
    for (let x = mx0 + 1; x <= mx1 - 1; x++) g.over(x, my + 1, lipLight);
  } else if (expr === "worried") {
    for (let x = mx0 + 1; x <= mx1 - 1; x++) g.over(x, my, lip);
    g.over(mx0, my + 1, lip);
    g.over(mx1, my + 1, lip);
  } else {
    for (let x = mx0; x <= mx1; x++) g.over(x, my, x === mx0 || x === mx1 ? mix(lip, s.base, 0.4) : lip);
    for (let x = mx0 + 1; x <= mx1 - 1; x++) g.over(x, my + 1, lipLight);
  }
  if (L.lines) { g.over(16, cy + 5, s.mid); g.over(23, cy + 5, s.mid); }
  if (L.blush) { g.over(15, cy + 3, mix(s.base, [214, 110, 110], 0.22)); g.over(24, cy + 3, mix(s.base, [214, 110, 110], 0.22)); }

  // eyes: lid line, white, iris with a highlight and a pupil
  for (const side of [-1, 1] as const) {
    const x0 = side < 0 ? 14 : 22;
    const at = (i: number) => (side < 0 ? x0 + i : x0 + 3 - i); // i = 0 is the outer corner
    if (pose.blink) {
      for (let i = 0; i < 4; i++) g.over(at(i), lid + 1, lash);
      g.over(at(0), lid + 2, lash);
    } else if (expr === "happy") {
      g.over(at(0), lid + 1, lash);
      g.over(at(1), lid, lash);
      g.over(at(2), lid, lash);
      g.over(at(3), lid + 1, lash);
    } else if (pose.look === "down") {
      for (let i = 0; i < 4; i++) g.over(at(i), lid + 1, lash);
      g.over(at(0), lid + 2, white);
      g.over(at(1), lid + 2, iris);
      g.over(at(2), lid + 2, pupil);
      g.over(at(3), lid + 2, white);
    } else {
      for (let i = 1; i < 4; i++) g.over(at(i), lid, lash);
      g.over(at(0), lid + 1, lash);
      const up = pose.look === "up";
      // iris block sits toward the nose so the two eyes converge
      g.over(at(1), lid + 1, up ? iris : white);
      g.over(at(2), lid + 1, side < 0 ? (up ? hl : iris) : hl);
      g.over(at(3), lid + 1, side < 0 ? hl : (up ? hl : iris));
      if (!up) {
        g.over(at(1), lid + 2, s.base);
        g.over(at(2), lid + 2, side < 0 ? iris : pupil);
        g.over(at(3), lid + 2, side < 0 ? pupil : iris);
      } else {
        g.over(at(2), lid + 1, side < 0 ? iris : hl);
        g.over(at(1), lid + 1, pupil);
      }
      g.over(at(0), lid + 2, s.base);
      if (expr === "worried") g.over(at(0), lid + 3, s.mid);
    }
  }

  // eyebrows
  const brow = L.hairStyle === "bald" || L.hairStyle === "buzz" || L.hairStyle === "hijab"
    ? mix(L.hair.base, s.line, 0.35)
    : L.hair.base[0] > 150 ? mix(L.hair.base, s.line, 0.5) : mix(L.hair.base, [10, 6, 8], 0.2);
  const browC = deep ? mix(brow, [8, 4, 4], 0.45) : brow;
  const by = lid - 2 - (expr === "happy" ? 1 : 0);
  for (const side of [-1, 1] as const) {
    const at = (i: number) => (side < 0 ? 13 + i : 26 - i); // i = 0 outer end
    for (let i = 0; i < 5; i++) {
      let y = by;
      if (L.browStyle === 1 && i === 0) y += 1; // arched: outer end lower
      if (expr === "worried" && i >= 3) y -= 1; // inner ends raised
      g.over(at(i), y, browC);
      if (L.browStyle === 2 && i >= 1 && i <= 3) g.over(at(i), y + 1, browC); // thick
    }
  }

  // glasses
  if (L.glasses) {
    const fr = L.glasses.frame;
    for (const side of [-1, 1] as const) {
      const x0 = side < 0 ? 13 : 21;
      for (let x = x0; x <= x0 + 5; x++) {
        const corner = L.glasses.round && (x === x0 || x === x0 + 5);
        if (!corner) { g.set(x, lid - 1, fr); g.set(x, lid + 3, fr); }
      }
      for (let y = lid - 1 + (L.glasses.round ? 1 : 0); y <= lid + 3 - (L.glasses.round ? 1 : 0); y++) {
        g.set(x0, y, fr);
        g.set(x0 + 5, y, fr);
      }
      // a glint in the top-left corner of the lens
      g.set(x0 + 1, lid, mix(g.get(x0 + 1, lid) ?? s.base, [255, 255, 255], 0.55));
      const tx = side < 0 ? x0 - 1 : x0 + 6;
      g.over(tx, lid, fr);
      g.over(side < 0 ? tx - 1 : tx + 1, lid, fr);
    }
    g.set(19, lid, fr);
    g.set(20, lid, fr);
  }
}

// ---------------------------------------------------------------------------------------------------- hair
function hairFill(L: Look, f: Face, curly: boolean) {
  const h = L.hair;
  return (px: number, py: number, x: number, y: number): RGB => {
    const dx = px - CX;
    const top = f.cy - f.ry;
    // sheen: a short arc of light on the upper left of the volume
    const d = Math.hypot(px - (CX + 3), py - (f.cy + 3));
    if (curly) {
      if ((x * 3 + y * 5) % 7 === 0) return h.hi;
      if ((x * 5 + y * 3) % 6 === 0 || dx > f.rx - 1) return h.mid;
      return h.base;
    }
    if (dx < -1 && py < f.cy - 2 && Math.abs(d - (f.ry + 2.2)) < 0.75) return h.hi;
    if (dx > f.rx - 1.5 || py > f.cy + 1) return h.mid;
    if (py < top + 0.5 && dx > 2) return h.mid;
    return h.base;
  };
}

function hairLine(L: Look, f: Face) {
  return (x: number, y: number): RGB | null => {
    const px = x + 0.5;
    const py = y + 0.5;
    // where hair meets the face, the outline is a soft cast shadow instead of a hard line
    if (inFace(f, px, py)) return mix(L.skin.lo, L.hair.base, 0.35);
    return L.hair.line;
  };
}

function hairline(L: Look, f: Face, dx: number): number {
  const a = Math.abs(dx);
  if (a > f.rx - 2.3) return f.cy + L.sideburn - 0.4;
  return f.cy - 5.7 + Math.pow(a / f.rx, 2) * 1.8;
}

function cap(L: Look, f: Face, grow: number, lift: number, line?: (px: number, py: number) => number) {
  return (px: number, py: number) => {
    const dx = px - CX;
    const top = py < f.cy;
    const ok = inEllipse(px, py, CX, f.cy - 0.4, f.rx + grow, f.ry + grow + (top ? lift : 0));
    return ok && py < (line ? line(px, py) : hairline(L, f, dx));
  };
}

function bumpy(px: number, py: number, cx: number, cy: number, rx: number, ry: number, freq: number, amp: number, phase: number): boolean {
  const ang = Math.atan2(py - cy, px - cx);
  const k = 1 + amp * Math.sin(freq * ang + phase);
  return inEllipse(px, py, cx, cy, rx * k, ry * k);
}

function paintHairBack(g: PixelGrid, L: Look, f: Face): void {
  const h = L.hair;
  const st = L.hairStyle;
  const fill = hairFill(L, f, st === "afro");
  if (st === "afro") {
    g.shape((px, py) => bumpy(px, py, CX, f.cy - 2.6, f.rx + 5.4, f.ry + 3.4, 11, 0.055, L.side), hairFill(L, f, true), h.line);
  } else if (st === "bob") {
    g.shape((px, py) => {
      const dx = Math.abs(px - CX);
      if (inEllipse(px, py, CX, f.cy - 0.6, f.rx + 2.4, f.ry + 2)) return py < f.cy + 7.2;
      return dx <= f.rx + 2.4 && py >= f.cy - 0.6 && py < f.cy + 7.2 - (dx > f.rx + 1.4 ? 0 : 0);
    }, (px, py, x, y) => (py > f.cy + 6 ? h.mid : fill(px, py, x, y)), h.line);
  } else if (st === "long") {
    g.shape((px, py) => {
      const dx = Math.abs(px - CX);
      if (inEllipse(px, py, CX, f.cy - 0.6, f.rx + 2.6, f.ry + 2.2)) return true;
      const w = f.rx + 2.6 + Math.max(0, py - f.cy - 5) * 0.28;
      return py >= f.cy - 0.6 && py < 41.5 - (Math.floor(px) % 2) && dx <= w;
    }, (px, py, x, y) => (py > f.cy + 3 ? (Math.floor(px) % 3 === 0 ? h.mid : h.base) : fill(px, py, x, y)), h.line);
  } else if (st === "ponytail") {
    const tx = CX + L.side * 10.2;
    g.shape((px, py) => inEllipse(px, py, tx, f.cy + 1.6, 2.1, 6.2) && py > f.cy - 5,
      (px) => ((px - tx) * L.side > 0.6 ? h.mid : h.base), h.line);
  } else if (st === "braids") {
    g.shape((px, py) => inEllipse(px, py, CX, f.cy - 0.6, f.rx + 1.6, f.ry + 1.6), fill, h.line);
  }
}

function paintHairFront(g: PixelGrid, L: Look, f: Face): void {
  const h = L.hair;
  const st = L.hairStyle;
  const line = hairLine(L, f);
  const fill = hairFill(L, f, st === "curly");
  switch (st) {
    case "bald": {
      g.over(15, Math.round(f.cy - f.ry + 2), L.skin.hi);
      g.over(16, Math.round(f.cy - f.ry + 2), L.skin.hi);
      g.over(16, Math.round(f.cy - f.ry + 1), L.skin.hi);
      if (L.side > 0) {
        g.shape((px, py) => Math.abs(px - CX) > f.rx - 1.2 && py > f.cy - 3.2 && py < f.cy + 0.6
          && inEllipse(px, py, CX, f.cy - 0.4, f.rx + 0.8, f.ry + 0.8), () => h.mid, h.line);
      }
      break;
    }
    case "buzz":
      g.shape(cap(L, f, 0.55, 0), (_px, _py, x, y) => ((x + 2 * y) % 4 === 0 ? mix(h.base, L.skin.base, 0.3) : h.base),
        (x, y) => (inFace(f, x + 0.5, y + 0.5) ? mix(L.skin.mid, h.base, 0.25) : mix(h.line, L.skin.line, 0.3)));
      break;
    case "short":
      g.shape(cap(L, f, 1.3, 1.2, (px) => hairline(L, f, px - CX) + (Math.floor(px) % 3 === 0 ? 0.9 : 0)), fill, line);
      break;
    case "sidepart": {
      const s = L.side;
      g.shape(cap(L, f, 1.4, 1.9, (px) => {
        const dx = px - CX;
        const a = Math.abs(dx);
        if (a > f.rx - 2.3) return hairline(L, f, dx);
        return f.cy - 6.4 + Math.max(0, -s * dx + 3) * 0.34;
      }), fill, line);
      for (let y = Math.floor(f.cy - f.ry - 2); y < f.cy - 6; y++) g.over(CX + s * 3 - (s > 0 ? 0 : 1), y, h.lo);
      break;
    }
    case "quiff":
      g.shape((px, py) => cap(L, f, 1.0, 0.6)(px, py) || inEllipse(px, py, CX - L.side * 2, f.cy - f.ry - 0.2, 5.6, 3.2),
        fill, line);
      break;
    case "curly":
      g.shape((px, py) => bumpy(px, py, CX, f.cy - 1.2, f.rx + 2.2, f.ry + 2.6, 9, 0.07, L.side)
        && py < (Math.abs(px - CX) > f.rx - 2.2 ? f.cy + 3 : f.cy - 5.2 + ((Math.floor(px) % 2) ? 0.9 : 0)), fill, line);
      break;
    case "afro":
      g.shape((px, py) => inFace(f, px, py) && py < hairline(L, f, px - CX) + 0.4, hairFill(L, f, true), line);
      break;
    case "bob":
      g.shape((px, py) => {
        const dx = Math.abs(px - CX);
        if (!inEllipse(px, py, CX, f.cy - 0.6, f.rx + 2.4, f.ry + 2)) return dx > f.rx - 1.6 && dx <= f.rx + 2.4 && py < f.cy + 7.2 && py > f.cy - 2;
        if (dx > f.rx - 1.6) return py < f.cy + 7.2;
        return py < f.cy - 3.6 - (Math.floor(px) % 2 ? 0 : 0.3);
      }, fill, line);
      break;
    case "long":
    case "braids":
    case "ponytail":
    case "bun": {
      const tight = st === "ponytail" || st === "bun";
      g.shape(cap(L, f, tight ? 0.8 : 1.2, tight ? 0.4 : 0.9, (px) => {
        const dx = px - CX;
        if (Math.abs(dx) > f.rx - 2.3) return st === "long" ? f.cy + 9 : hairline(L, f, dx);
        return f.cy - 5.9 + Math.pow(Math.abs(dx) / f.rx, 2) * 2.4 + (st === "long" ? Math.max(0, 2.4 - Math.abs(dx)) * 0.0 : 0);
      }), fill, line);
      if (st !== "ponytail") {
        // centre part
        for (let y = Math.floor(f.cy - f.ry - 1); y < f.cy - 6.4; y++) g.over(19, y, h.lo);
      }
      if (st === "bun") {
        const bx = CX - 0.5 + (L.print % 2 ? 0 : L.side * 1.5);
        g.shape((px, py) => inEllipse(px, py, bx, f.cy - f.ry - 2.2, 3.5, 3.1), fill, h.line);
        g.over(Math.floor(bx) - 1, Math.floor(f.cy - f.ry - 3), h.hi);
      }
      if (st === "ponytail") {
        const tx = Math.floor(CX + L.side * 8.6);
        g.set(tx, Math.floor(f.cy - 4), hex("#5b6474"));
        g.set(tx, Math.floor(f.cy - 3), hex("#5b6474"));
      }
      break;
    }
    case "hijab":
      break;
  }
}

/** Long-hair strands and braids that fall in front of the shoulders (drawn after the body). */
function paintHairOverBody(g: PixelGrid, L: Look, f: Face): void {
  const h = L.hair;
  if (L.hairStyle === "braids") {
    for (const sx of [-1, 1]) {
      const x0 = CX + sx * (f.rx + 1.1);
      g.shape((px, py) => Math.abs(px - x0) <= 1.6 && py > f.cy - 1 && py < 43.5,
        (_px, _py, x, y) => ((y + (x % 2)) % 2 === 0 ? h.base : h.mid), h.line);
      const bx = Math.floor(x0 - 0.5);
      g.set(bx, 44, hex("#5b6474"));
      g.set(bx + 1, 44, hex("#5b6474"));
    }
  } else if (L.hairStyle === "long") {
    for (const sx of [-1, 1]) {
      g.shape((px, py) => {
        const dx = (px - CX) * sx;
        return dx > f.rx - 0.8 && dx < f.rx + 3.4 + Math.max(0, py - 33) * 0.2 && py > f.cy + 4 && py < 41 - ((Math.floor(px) + 1) % 2);
      }, (px) => (Math.floor(px) % 3 === 0 ? h.mid : h.base), h.line);
    }
  }
}

function paintHijab(g: PixelGrid, L: Look, f: Face): void {
  const c = L.scarf;
  g.shape((px, py) => {
    const dx = Math.abs(px - CX);
    if (inEllipse(px, py, CX, f.cy, f.rx + 3.2, f.ry + 3)) return true;
    const w = f.rx + 3.2 + Math.max(0, py - f.cy - 3) * 0.55;
    return py >= f.cy && py < 39.5 - (dx > 9 ? (dx - 9) * 1.2 : 0) && dx <= Math.min(w, 12.5);
  }, (px, py) => {
    const dx = px - CX;
    if (dx > f.rx) return c.mid;
    if (py > f.cy + f.ry + 1 && Math.abs(dx) < 6 && Math.floor(py) % 3 === 0) return c.mid; // drape folds
    if (dx < -f.rx + 1 && py < f.cy) return c.hi;
    return c.base;
  }, c.line);
}

function inOpening(f: Face) {
  return (px: number, py: number) => inEllipse(px, py, CX, f.cy + 1.2, f.rx - 0.6, f.ry - 1.4);
}

// ---------------------------------------------------------------------------------------------------- hands
function paintTyping(g: PixelGrid, L: Look, frame: 1 | 2): void {
  const kb = ramp(hex("#d5dae1"), [40, 46, 60]);
  g.shape((px, py) => px > 8 && px < 32 && py > 44.4, (_px, py, x) => (py < 45.5 ? kb.hi : x % 3 === 0 ? kb.mid : kb.base), kb.line);
  const s = L.skin;
  for (const sx of [-1, 1] as const) {
    const up = (sx < 0 && frame === 1) || (sx > 0 && frame === 2) ? 1 : 0;
    const hx = CX + sx * 6.5;
    g.shape((px, py) => inEllipse(px, py, hx, 44.2 - up, 2.3, 1.6), (px) => ((px - hx) * sx > 0.5 ? s.mid : s.base), s.line);
    // cuff
    g.shape((px, py) => inEllipse(px, py, hx + sx * 2.6, 42.6 - up, 1.6, 1.4), () => L.cloth.mid, L.cloth.line);
  }
}

// ---------------------------------------------------------------------------------------------------- entry
export function paintHuman(g: PixelGrid, spec: IdentitySpec, pose: Pose = {}): void {
  // theater-1016: the head sits 2 px lower than v2 (a shorter neck; Alfredo: "cuello muy angosto y alto")
  const cy = 20 - (pose.breath === 1 ? 1 : 0);
  const L = chooseLook(spec, cy);
  const f = L.face;
  if (L.hairStyle === "hijab") {
    paintBody(g, L);
    paintHijab(g, L, f);
    paintHead(g, L, f, inOpening(f));
    paintFeatures(g, L, f, pose);
  } else {
    paintHairBack(g, L, f);
    paintBody(g, L);
    paintNeck(g, L, f);
    paintHairOverBody(g, L, f);
    paintEars(g, L, f);
    paintHead(g, L, f);
    paintFeatures(g, L, f, pose);
    paintHairFront(g, L, f);
    if (L.glasses) repaintGlassesOverHair(g, L, f);
  }
  if (pose.typing) paintTyping(g, L, pose.typing);
}

/** Glasses temples sit over side hair; re-stamp just the frame fronts so a fringe never hides them. */
function repaintGlassesOverHair(g: PixelGrid, L: Look, f: Face): void {
  if (!L.glasses) return;
  const lid = Math.round(f.cy) - 1;
  const fr = L.glasses.frame;
  for (const x0 of [13, 21]) {
    for (let y = lid; y <= lid + 3; y++) { g.set(x0, y, fr); g.set(x0 + 5, y, fr); }
    for (let x = x0 + (L.glasses.round ? 1 : 0); x <= x0 + 5 - (L.glasses.round ? 1 : 0); x++) g.set(x, lid + 3, fr);
  }
}

export const HUMAN_GRID = { w: W, h: H };
