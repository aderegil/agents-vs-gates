// AI-agent portraits (v2): same 40×48 bust as the humans, but plainly machines: a shell head with a screen face,
// a chassis with shoulder pads and a chest plate. The family (vendor / model line) sets the head shape and palette;
// the role sets the chest emblem; the seed varies shell tone, trim, eyes, mouth and antenna inside the family.
// Pure and deterministic, like human.ts.
import { PixelGrid, hex, inEllipse, inRoundRect, mix, ramp, type Mask, type RGB, type Ramp } from "./pixels.ts";
import { pick, rngFromSeed } from "./rng.ts";
import {
  agentFamily, emblemFor, type AgentFamily, type Emblem, type IdentitySpec, type Pose,
} from "./identity.ts";

const CX = 20;

type HeadShape = "monitor" | "squircle" | "box" | "dome" | "hex" | "crate";
type Antenna = "none" | "single" | "double" | "side" | "dish";
type EyeStyle = "dots" | "tall" | "bars" | "ring" | "wide";
type MouthStyle = "none" | "line" | "grill" | "smile";

interface FamilyStyle {
  head: HeadShape;
  shell: string[];
  body: string[];
  trim: string[];
  screen: string;
  glow: string[];
  plate: string;
  antennas: Antenna[];
  eyes: EyeStyle[];
}

export const FAMILIES: Record<AgentFamily, FamilyStyle> = {
  // the experiment's own agents: slate monitor head, console blue trim
  avg: {
    head: "monitor", shell: ["#4a6082", "#3f5677", "#56698a"], body: ["#33435c", "#2e3d55"],
    trim: ["#2563eb", "#4c6fd1", "#7f93b8"], screen: "#0e1a2e", glow: ["#9cc0ff", "#c4d6ff", "#8fb0f0"],
    plate: "#e4e9f1", antennas: ["none", "single", "side", "double", "dish"], eyes: ["dots", "tall", "bars", "ring", "wide"],
  },
  // Anthropic / Claude: soft squircle head in clay, ivory chassis
  anthropic: {
    head: "squircle", shell: ["#d97757", "#c96a4b", "#d4825f"], body: ["#ece6da", "#e4dccd"],
    trim: ["#a85a3f", "#8a7f71", "#5f564b"], screen: "#2a201c", glow: ["#f6ead8", "#ffd8b5", "#fff3e6"],
    plate: "#f8f4ec", antennas: ["none", "none", "single", "side"], eyes: ["dots", "tall", "ring", "wide"],
  },
  // AWS AI-DLC: chamfered box head in squid-ink navy, orange visor light
  aws: {
    head: "box", shell: ["#232f3e", "#2c3b4e", "#1c2633"], body: ["#3a4a5e", "#324154"],
    trim: ["#ff9900", "#e98b1a", "#c9d1db"], screen: "#090e15", glow: ["#ffb340", "#ffc56b", "#ffa424"],
    plate: "#e7eaee", antennas: ["none", "side", "single", "dish"], eyes: ["bars", "wide", "dots"],
  },
  // Kiro: ghost-like dome in lilac white, violet chassis
  kiro: {
    head: "dome", shell: ["#f1edff", "#e8e1ff", "#f7f4ff"], body: ["#7b5cf0", "#6a4cdc", "#8667f2"],
    trim: ["#4c33b8", "#a593ff", "#3d2a94"], screen: "#1d1442", glow: ["#d9ccff", "#ffffff", "#c2b0ff"],
    plate: "#f3efff", antennas: ["none", "none", "single"], eyes: ["tall", "dots", "ring"],
  },
  // ai-sdlc.io: octagonal head in sage teal, twin antennas, lime screen
  aisdlc: {
    head: "hex", shell: ["#2f6f5e", "#2a6455", "#3a7d6a"], body: ["#3e4f4a", "#36463f"],
    trim: ["#9cc45a", "#7fae4f", "#c3d98a"], screen: "#0b221d", glow: ["#c0f292", "#dcf8b4", "#a8e57a"],
    plate: "#e3ece6", antennas: ["double", "double", "dish"], eyes: ["dots", "bars", "wide", "ring"],
  },
  // mock agent: grey crate head with amber light and the mock stripe on its shoulders
  mock: {
    head: "crate", shell: ["#a9adb4", "#9ea3ab", "#b3b7be"], body: ["#7c818a", "#71767f"],
    trim: ["#f59e0b", "#e9a23b"], screen: "#25272c", glow: ["#f8bd4a", "#ffd27a"],
    plate: "#eceef0", antennas: ["single", "none", "side"], eyes: ["dots", "bars", "ring"],
  },
};

// 9×9 role emblems for the chest plate. '#' ink, 'a' trim, 'l' light, 'g' glow, '.' plate.
export const EMBLEMS: Record<Emblem, string[]> = {
  magnifier: ["..###....", ".#lll#...", "#lllll#..", "#lllll#..", "#lllll#..", ".#lll#a..", "..###aaa.", "......aaa", ".......a."],
  shield: [".#######.", "#aaaalll#", "#aaaalll#", "#aaaalll#", "#aaaalll#", ".#aaall#.", "..#aal#..", "...#a#...", "....#...."],
  gear: ["....a....", ".a.aaa.a.", "..aaaaa..", ".aaa.aaa.", "aaa...aaa", ".aaa.aaa.", "..aaaaa..", ".a.aaa.a.", "....a...."],
  check: [".........", ".........", ".......aa", "......aaa", "aa...aaa.", "aaa.aaa..", ".aaaaa...", "..aaa....", "...a....."],
  wrench: ["......a.a", ".....aa.a", ".....aaaa", "....aaa..", "...aaa...", "..aaa....", ".aaa.....", "aaa......", ".a......."],
  rocket: ["....a....", "...aaa...", "...ala...", "...aaa...", "...aaa...", "..aaaaa..", ".aa.a.aa.", "....g....", "...g.g..."],
  compass: ["....#....", "...#a#...", "...a.a...", "..a...a..", "..a...a..", ".a.....a.", ".a.....a.", "a.......#", "a........"],
  setsquare: ["a........", "aa.......", "a.a......", "a..a.....", "a...a..#.", "a....a.#.", "a.....a#.", "aaaaaaaa.", ".......#."],
  document: ["######...", "#llll##..", "#l##lll#.", "#llllll#.", "#l####l#.", "#llllll#a", "#l###laa.", "#lllllaa.", "#######.."],
  clipboard: ["...aaa...", ".#######.", ".#lllll#.", ".#al##l#.", ".#lllll#.", ".#al##l#.", ".#lllll#.", ".#al##l#.", ".#######."],
  book: [".........", ".##...##.", "#ll#.#ll#", "#lll#lll#", "#lll#lll#", "#lll#lll#", "#lll#lll#", "##aa#aa##", "........."],
  scissors: ["a.......a", ".a.....a.", "..a...a..", "...a.a...", "....a....", "...a.a...", ".aaa.aaa.", "a..a.a..a", ".aa...aa."],
  nodes: ["...aaa...", "...aaa...", "....#....", "...#.#...", "..#...#..", ".#.....#.", "aaa...aaa", "aaa...aaa", "........."],
  code: [".........", ".....a...", "..a..aa..", ".a..a..a.", "a...a...a", ".a..a..a.", "..aa..a..", "...a.....", "........."],
  pulse: [".........", "...a.....", "..aa.....", "..a.a....", "aa..a..aa", "....a.a..", ".....a...", ".........", "........."],
  chip: ["..a.a.a..", ".#######.", "a#lllll#a", ".#l###l#.", "a#l#g#l#a", ".#l###l#.", "a#lllll#a", ".#######.", "..a.a.a.."],
};

interface Bot {
  family: AgentFamily;
  st: FamilyStyle;
  shell: Ramp;
  body: Ramp;
  trim: Ramp;
  screen: RGB;
  glow: RGB;
  plate: Ramp;
  antenna: Antenna;
  eyes: EyeStyle;
  mouth: MouthStyle;
  cheeks: boolean;
  emblem: Emblem;
  side: 1 | -1;
  wide: number;
}

function chooseBot(spec: IdentitySpec): Bot {
  const family = agentFamily(spec);
  const st = FAMILIES[family];
  const rng = rngFromSeed(`agent-v2:${spec.seed}`);
  const shellC = hex(pick(rng, st.shell));
  const outline: RGB = family === "kiro" ? [40, 26, 92] : [20, 18, 30];
  return {
    family,
    st,
    shell: ramp(shellC, outline),
    body: ramp(hex(pick(rng, st.body)), outline),
    trim: ramp(hex(pick(rng, st.trim)), outline),
    screen: hex(st.screen),
    glow: hex(pick(rng, st.glow)),
    plate: ramp(hex(st.plate), [30, 34, 48]),
    antenna: pick(rng, st.antennas),
    eyes: pick(rng, st.eyes),
    mouth: pick(rng, ["none", "line", "grill", "smile"] as MouthStyle[]),
    cheeks: rng() < 0.4,
    emblem: emblemFor(spec),
    side: rng() < 0.5 ? 1 : -1,
    wide: pick(rng, [0, 0, 1]),
  };
}

// ---------------------------------------------------------------------------------------------------- head geometry
interface HeadGeo {
  mask: Mask;
  screen: Mask;
  top: number;
  eyeY: number;
  mouthY: number;
  eyeDx: number;
}

function headGeo(b: Bot, oy: number): HeadGeo {
  const w = b.wide;
  switch (b.st.head) {
    case "monitor":
      return {
        mask: (px, py) => inRoundRect(px, py, 8 - w, 9 + oy, 32 + w, 29 + oy, 3.5),
        screen: (px, py) => inRoundRect(px, py, 11 - w, 12 + oy, 29 + w, 26 + oy, 2),
        top: 9 + oy, eyeY: 17 + oy, mouthY: 22 + oy, eyeDx: 5,
      };
    case "squircle":
      return {
        mask: (px, py) => inEllipse(px, py, CX, 19.5 + oy, 12.4 + w, 10.4, 3.2),
        screen: (px, py) => inEllipse(px, py, CX, 20 + oy, 9.2 + w, 6.6, 3.4),
        top: 9 + oy, eyeY: 18 + oy, mouthY: 23 + oy, eyeDx: 5,
      };
    case "box": {
      const hw = 11.5 + w;
      const hh = 10.5;
      const c = 3.2;
      return {
        mask: (px, py) => {
          const a = Math.abs(px - CX);
          const d = Math.abs(py - (19 + oy));
          return a <= hw && d <= hh && Math.max(0, a - (hw - c)) + Math.max(0, d - (hh - c)) <= c;
        },
        screen: (px, py) => Math.abs(px - CX) <= hw - 1.6 && py > 15 + oy && py < 22 + oy,
        top: 8.5 + oy, eyeY: 18 + oy, mouthY: 25 + oy, eyeDx: 5,
      };
    }
    case "dome":
      return {
        mask: (px, py) => {
          const a = Math.abs(px - CX);
          if (py < 19.5 + oy) return inEllipse(px, py, CX, 19.5 + oy, 11.6 + w, 11.2);
          // ghost hem: a scalloped lower edge
          return a <= 11.6 + w && py < 28.2 + oy + (Math.floor((px + 0.5) / 3) % 2 ? 0 : 1);
        },
        screen: (px, py) => inEllipse(px, py, CX, 18.5 + oy, 8 + w, 5.6),
        top: 8.3 + oy, eyeY: 17 + oy, mouthY: 21 + oy, eyeDx: 4,
      };
    case "hex":
      return {
        mask: (px, py) => {
          const a = Math.abs(px - CX);
          const d = Math.abs(py - (19.5 + oy));
          return a <= 11.6 + w && d <= 10.4 && a + d <= 17.6 + w;
        },
        screen: (px, py) => {
          const a = Math.abs(px - CX);
          const d = Math.abs(py - (19.5 + oy));
          return a <= 8.6 + w && d <= 6.6 && a + d <= 12.4 + w;
        },
        top: 9 + oy, eyeY: 18 + oy, mouthY: 23 + oy, eyeDx: 5,
      };
    case "crate":
    default:
      return {
        mask: (px, py) => inRoundRect(px, py, 9 - w, 9 + oy, 31 + w, 29 + oy, 1.6),
        screen: (px, py) => inRoundRect(px, py, 12 - w, 13 + oy, 28 + w, 25 + oy, 1),
        top: 9 + oy, eyeY: 17 + oy, mouthY: 22 + oy, eyeDx: 4,
      };
  }
}

// ---------------------------------------------------------------------------------------------------- parts
function paintChassis(g: PixelGrid, b: Bot): void {
  const body = b.body;
  g.shape((px, py) => inRoundRect(px, py, 3, 34, 37, 52, 4.5), (px, py) => {
    const dx = px - CX;
    if (dx > 12) return body.lo;
    if (dx > 7) return body.mid;
    if (dx < -12 && py < 41) return body.hi;
    return body.base;
  }, body.line);
  // side vents
  for (const sx of [-1, 1]) for (const y of [42, 44, 46]) for (let i = 0; i < 3; i++) g.over(CX + sx * (10 + i) - (sx > 0 ? 0 : 1), y, body.lo);
  // shoulder pads
  const t = b.trim;
  for (const sx of [-1, 1] as const) {
    const x0 = sx < 0 ? 1.6 : 28.4;
    g.shape((px, py) => inRoundRect(px, py, x0, 32.6, x0 + 10, 40.4, 2.6), (px, py, x, y) => {
      if (b.family === "mock") return (x + y) % 4 < 2 ? hex("#26272b") : t.base; // the mock stripe
      if (py < 34.5 && px < CX) return t.hi;
      return px > CX ? t.mid : t.base;
    }, t.line);
  }
  // status LED on the left pad
  g.set(5, 35, b.glow);
  // chest plate with the role emblem
  const p = b.plate;
  g.shape((px, py) => inRoundRect(px, py, 12.6, 35.4, 27.4, 50, 2), (px) => (px > 25 ? p.mid : p.base), body.line);
  const ink = mix(b.body.base, [10, 12, 20], 0.55);
  const accent = b.family === "kiro" ? hex("#5b3fd6") : b.family === "anthropic" ? hex("#b5583a")
    : b.family === "aws" ? hex("#e57f00") : b.family === "aisdlc" ? hex("#3f7f2f") : b.family === "mock" ? hex("#c27803")
      : hex("#2563eb");
  g.bitmap(15, 37, EMBLEMS[b.emblem], { "#": ink, a: accent, l: [255, 255, 255], g: b.family === "mock" ? hex("#f59e0b") : accent });
}

function paintNeck(g: PixelGrid, b: Bot, oy: number): void {
  const n = ramp(mix(b.body.base, [140, 146, 160], 0.35));
  // theater-1016: a wider, stockier neck (was 3.4 half-width with two rings)
  g.shape((px, py) => Math.abs(px - CX) <= 5 && py > 26 + oy && py < 35.5, (px) => (px > CX + 2 ? n.mid : n.base), n.line);
  for (let x = 16; x <= 23; x++) g.over(x, 31, n.lo);
}

function paintAntenna(g: PixelGrid, b: Bot, h: HeadGeo): void {
  const rod = b.shell.line;
  const top = Math.floor(h.top);
  const ball = (x: number, y: number) => {
    g.shape((px, py) => inEllipse(px, py, x + 0.5, y + 0.5, 1.6, 1.6), () => b.glow, b.trim.line);
  };
  switch (b.antenna) {
    case "single": {
      const x = CX + (b.side > 0 ? 0 : -1);
      for (let y = top - 4; y < top; y++) g.set(x, y, rod);
      ball(x, top - 5);
      break;
    }
    case "double":
      for (const sx of [-1, 1]) {
        const x = CX + sx * 5 - (sx > 0 ? 0 : 1);
        for (let i = 0; i < 4; i++) g.set(x + sx * (i >> 1), top - 1 - i, rod);
        ball(x + sx * 2, top - 5);
      }
      break;
    case "side": {
      const x = b.side > 0 ? 33 : 6;
      for (let y = top; y < top + 9; y++) g.set(x, y, rod);
      g.shape((px, py) => inEllipse(px, py, x + 0.5, top - 0.5, 1.5, 1.5), () => b.trim.base, b.trim.line);
      break;
    }
    case "dish": {
      const x = CX + b.side * 6;
      g.shape((px, py) => inEllipse(px, py, x, top - 1.6, 3.2, 1.4) && py < top - 1, () => b.trim.base, b.trim.line);
      g.set(Math.floor(x), top - 1, rod);
      break;
    }
    default:
      break;
  }
}

function paintEars(g: PixelGrid, b: Bot, oy: number): void {
  const t = b.trim;
  const s = b.shell;
  switch (b.st.head) {
    case "monitor":
    case "crate":
      for (const sx of [-1, 1]) {
        const x0 = sx < 0 ? 5.2 - b.wide : 31.2 + b.wide;
        g.shape((px, py) => inRoundRect(px, py, x0, 15 + oy, x0 + 3.6, 23 + oy, 1), (px) => (px > CX ? s.mid : s.base), s.line);
        g.set(Math.floor(x0 + 1.8), 18 + oy, t.base);
        g.set(Math.floor(x0 + 1.8), 19 + oy, t.base);
      }
      break;
    case "squircle":
      for (const sx of [-1, 1]) {
        const ex = CX + sx * (12.6 + b.wide);
        g.shape((px, py) => inEllipse(px, py, ex, 20 + oy, 2, 3.2), () => b.body.base, b.body.line);
      }
      break;
    case "box":
      for (const sx of [-1, 1]) {
        const x0 = sx < 0 ? 5.6 - b.wide : 31.4 + b.wide;
        g.shape((px, py) => px > x0 && px < x0 + 3 && py > 16 + oy && py < 23 + oy, () => t.base, t.line);
      }
      break;
    case "hex":
      for (const sx of [-1, 1]) {
        const x0 = sx < 0 ? 5.4 - b.wide : 31.6 + b.wide;
        g.shape((px, py) => inEllipse(px, py, x0 + 1.5, 19.5 + oy, 1.6, 2.4), () => t.base, t.line);
      }
      break;
    default:
      break;
  }
}

function paintHead(g: PixelGrid, b: Bot, h: HeadGeo): void {
  const s = b.shell;
  g.shape(h.mask, (px, py) => {
    const dx = px - CX;
    if (!h.mask(px + 1.8, py) || !h.mask(px, py + 1.8)) return s.mid;
    if (dx < -4 && !h.mask(px - 2.2, py) && py < 20) return s.hi;
    if (!h.mask(px, py - 2.2) && dx < 3) return s.hi;
    return s.base;
  }, s.line);
  // screen with a dark bezel
  const bezel = mix(b.screen, b.shell.line, 0.4);
  g.shape(h.screen, (px, py) => (!h.screen(px, py - 1) ? mix(b.screen, [255, 255, 255], 0.06) : b.screen), bezel,
    (x, y) => h.mask(x + 0.5, y + 0.5));
  // family details on the shell
  if (b.st.head === "box") {
    for (const x of [16, 19, 22]) for (let i = 0; i < 2; i++) g.over(x + i, Math.floor(h.top) + 3, s.lo);
    for (let x = 15; x <= 24; x++) if (x % 2) { g.over(x, h.mouthY, s.lo); g.over(x, h.mouthY + 2, s.lo); }
  } else if (b.st.head === "crate") {
    for (let y = Math.floor(h.top) + 1; y < h.top + 20; y += 2) { g.over(10 - b.wide, y, s.mid); g.over(29 + b.wide, y, s.mid); }
  } else if (b.st.head === "monitor") {
    g.over(28 + b.wide, 27 + (h.top - 9), b.glow);
  }
}

function paintFace(g: PixelGrid, b: Bot, h: HeadGeo, pose: Pose): void {
  const glow = b.glow;
  const soft = mix(b.glow, b.screen, 0.55);
  const expr = pose.expression ?? "neutral";
  const lookDy = pose.look === "down" ? 1 : pose.look === "up" ? -1 : 0;
  const ey = h.eyeY + lookDy;
  const on = (x: number, y: number, c: RGB) => {
    if (h.screen(x + 0.5, y + 0.5)) g.set(x, y, c);
  };
  for (const side of [-1, 1] as const) {
    const ex = side < 0 ? CX - h.eyeDx - 1 : CX + h.eyeDx - 1; // left column of a 2-wide eye
    if (b.st.head === "box") {
      // AWS visor: a light bar per eye that narrows when blinking
      const w = pose.blink ? 2 : 4;
      const x0 = side < 0 ? CX - 8 : CX + 4;
      if (pose.blink || expr !== "neutral" || b.eyes === "bars") {
        for (let i = 0; i < w; i++) on(x0 + i + (4 - w) / 2, ey, glow);
        if (!pose.blink && expr !== "happy") for (let i = 0; i < 4; i++) on(x0 + i, ey + 1, soft);
      } else if (b.eyes === "dots") {
        for (const [dx, dy] of [[1, 0], [2, 0], [1, 1], [2, 1]]) on(x0 + dx, ey + dy, glow);
        on(x0 + (side < 0 ? 1 : 2), ey, [255, 255, 255]);
      } else {
        // a scanner: one continuous line across the visor with a bright segment per eye
        for (let x = CX - 9; x <= CX + 8; x++) on(x, ey + 1, soft);
        for (let i = 0; i < 4; i++) on(x0 + i, ey + 1, glow);
        on(x0 + 1, ey, soft);
        on(x0 + 2, ey, soft);
      }
      if (expr === "happy") { on(x0, ey + 1, glow); on(x0 + 3, ey + 1, glow); }
      if (expr === "worried") { on(side < 0 ? x0 + 3 : x0, ey - 2, soft); on(side < 0 ? x0 + 2 : x0 + 1, ey - 2, soft); }
      continue;
    }
    if (pose.blink) {
      for (let i = -1; i < 3; i++) on(ex + i, ey + 1, soft);
      continue;
    }
    if (expr === "happy") {
      on(ex - 1, ey + 1, glow); on(ex, ey, glow); on(ex + 1, ey, glow); on(ex + 2, ey + 1, glow);
      continue;
    }
    switch (b.eyes) {
      case "dots":
        on(ex, ey, glow); on(ex + 1, ey, glow); on(ex, ey + 1, glow); on(ex + 1, ey + 1, glow);
        on(ex + (side < 0 ? 0 : 1), ey, [255, 255, 255]);
        break;
      case "tall":
        for (let y = ey - 1; y <= ey + 1; y++) { on(ex, y, glow); on(ex + 1, y, glow); }
        on(ex, ey - 1, [255, 255, 255]);
        break;
      case "bars":
        for (let i = -1; i < 3; i++) on(ex + i, ey + 1, glow);
        on(ex - 1, ey + 1, soft); on(ex + 2, ey + 1, soft);
        break;
      case "ring":
        for (const [dx, dy] of [[0, -1], [1, -1], [-1, 0], [2, 0], [-1, 1], [2, 1], [0, 2], [1, 2]]) on(ex + dx, ey + dy, glow);
        break;
      case "wide":
        for (let i = -1; i < 3; i++) { on(ex + i, ey, glow); on(ex + i, ey + 1, soft); }
        break;
    }
    if (expr === "worried") {
      // a short slanted brow over each eye, inner end up
      on(side < 0 ? ex + 1 : ex, ey - 2 - (b.eyes === "tall" || b.eyes === "ring" ? 1 : 0), soft);
      on(side < 0 ? ex : ex + 1, ey - 1 - (b.eyes === "tall" || b.eyes === "ring" ? 1 : 0), soft);
    }
  }
  // mouth
  const my = h.mouthY + (b.st.head === "box" ? -5 : 0);
  if (b.st.head === "box") {
    // AWS mouth lives on the grill; talking lights two grill slots
    if (pose.mouth === "open") for (let x = 17; x <= 22; x++) if (x % 2) g.over(x, h.mouthY + 1, glow);
    return;
  }
  if (pose.mouth === "open") {
    for (let x = CX - 2; x <= CX + 1; x++) { on(x, my, glow); on(x, my + 1, soft); }
    return;
  }
  if (expr === "happy") {
    on(CX - 3, my - 1, glow); on(CX + 2, my - 1, glow);
    for (let x = CX - 2; x <= CX + 1; x++) on(x, my, glow);
    return;
  }
  if (expr === "worried") {
    on(CX - 3, my + 1, soft); on(CX - 2, my, soft); on(CX - 1, my, soft); on(CX, my, soft); on(CX + 1, my, soft); on(CX + 2, my + 1, soft);
    return;
  }
  switch (b.mouth) {
    case "line":
      for (let x = CX - 2; x <= CX + 1; x++) on(x, my, soft);
      break;
    case "grill":
      for (const x of [CX - 3, CX - 1, CX + 1]) on(x, my, soft);
      break;
    case "smile":
      on(CX - 2, my - 1, soft); on(CX + 1, my - 1, soft); on(CX - 1, my, soft); on(CX, my, soft);
      break;
    default:
      break;
  }
  if (b.cheeks) { on(CX - h.eyeDx - 3, my - 1, mix(glow, b.screen, 0.7)); on(CX + h.eyeDx + 2, my - 1, mix(glow, b.screen, 0.7)); }
}

function paintTyping(g: PixelGrid, b: Bot, frame: 1 | 2): void {
  const kb = ramp(hex("#d5dae1"), [40, 46, 60]);
  g.shape((px, py) => px > 8 && px < 32 && py > 44.4, (_px, py, x) => (py < 45.5 ? kb.hi : x % 3 === 0 ? kb.mid : kb.base), kb.line);
  const t = b.trim;
  for (const sx of [-1, 1] as const) {
    const up = (sx < 0 && frame === 1) || (sx > 0 && frame === 2) ? 1 : 0;
    const hx = CX + sx * 6.5;
    g.shape((px, py) => inRoundRect(px, py, hx - 2.2, 42.6 - up, hx + 2.2, 45.4 - up, 1), (px) => ((px - hx) * sx > 0.6 ? t.mid : t.base), t.line);
  }
}

export function paintAgent(g: PixelGrid, spec: IdentitySpec, pose: Pose = {}): void {
  const b = chooseBot(spec);
  const oy = pose.breath === 1 ? -1 : 0;
  const h = headGeo(b, oy);
  paintChassis(g, b);
  paintNeck(g, b, oy);
  paintEars(g, b, oy);
  paintAntenna(g, b, h);
  paintHead(g, b, h);
  paintFace(g, b, h, pose);
  if (pose.typing) paintTyping(g, b, pose.typing);
}
