function shade(hex, amount) {
	const c = hex.replace("#", "");
	const r = parseInt(c.substring(0, 2), 16);
	const g = parseInt(c.substring(2, 4), 16);
	const b = parseInt(c.substring(4, 6), 16);
	const adj = (v) => Math.max(0, Math.min(255, Math.round(v + amount)));
	return `rgb(${adj(r)}, ${adj(g)}, ${adj(b)})`;
}
function seededJitter(seed, salt) {
	const x = Math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453;
	return x - Math.floor(x);
}
var HEAD_CX = 11;
var HEAD_CY = 10.5;
var HEAD_RX = 5.6;
var HEAD_RY = 6.4;
function isInHead(x, y) {
	const dx = (x - HEAD_CX) / HEAD_RX;
	const dy = (y - HEAD_CY) / HEAD_RY;
	return dx * dx + dy * dy <= 1;
}
function hairCovers(style, x, y, jitter) {
	const dx = (x - HEAD_CX) / HEAD_RX;
	const dy = (y - HEAD_CY - 1) / 7.4;
	const inHeadish = dx * dx + dy * dy <= 1.05 + jitter * .08;
	const topBand = y <= 9 + jitter * 1.5;
	switch (style) {
		case "bald": return topBand && y <= 6 && inHeadish;
		case "short": return inHeadish && topBand;
		case "curly": {
			const bumpy = seededJitter(x * 3.1 + 1, y * 1.7) > .35;
			return inHeadish && (topBand || y < 11.5 && bumpy && Math.abs(x - HEAD_CX) > 3.5999999999999996);
		}
		case "bun": return inHeadish && topBand || y < 5 && Math.abs(x - HEAD_CX) < 2;
		case "long": return inHeadish && topBand || y >= 9.5 && y < 25 && Math.abs(x - HEAD_CX) > 3.3999999999999995;
		default: return false;
	}
}
function paintAvatar(ctx, options) {
	const { appearance, mood, seed } = options;
	const img = ctx.createImageData(22, 28);
	const setPixel = (x, y, hex, alpha = 255) => {
		if (x < 0 || x >= 22 || y < 0 || y >= 28) return;
		const idx = (y * 22 + x) * 4;
		const c = hex.startsWith("rgb") ? hex.match(/\d+/g).map(Number) : [
			parseInt(hex.slice(1, 3), 16),
			parseInt(hex.slice(3, 5), 16),
			parseInt(hex.slice(5, 7), 16)
		];
		img.data[idx] = c[0];
		img.data[idx + 1] = c[1];
		img.data[idx + 2] = c[2];
		img.data[idx + 3] = alpha;
	};
	const jitter = seededJitter(seed, 4.2);
	for (let y = 0; y < 28; y++) for (let x = 0; x < 22; x++) {
		const shoulderTop = 17 - Math.abs(x - HEAD_CX) * .35;
		if (y >= shoulderTop) {
			const lit = x < HEAD_CX ? shade(appearance.shirtColor, 14) : shade(appearance.shirtColor, -10);
			setPixel(x, y, lit);
		}
	}
	for (let y = 15; y < 19; y++) for (let x = 9.5; x <= 12.5; x++) setPixel(Math.round(x), y, shade(appearance.skinTone, -12));
	for (let y = 0; y < 28; y++) for (let x = 0; x < 22; x++) {
		if (!isInHead(x, y)) continue;
		const dx = x - HEAD_CX;
		const dy = y - HEAD_CY;
		const lightDot = -dx * .7 - dy * .5;
		let tone = appearance.skinTone;
		if (lightDot > 3) tone = shade(tone, 18);
		else if (lightDot < -3.2) tone = shade(tone, -22);
		else if (lightDot < -1) tone = shade(tone, -8);
		setPixel(x, y, tone);
	}
	for (let y = 0; y < 28; y++) for (let x = 0; x < 22; x++) {
		if (!hairCovers(appearance.hairStyle, x, y, jitter)) continue;
		const tone = x - HEAD_CX < -1 ? shade(appearance.hairColor, 10) : shade(appearance.hairColor, -6);
		setPixel(x, y, tone);
	}
	const browY = Math.round(8.9 + (mood < -.25 ? 0 : mood > .35 ? -1 : -.3));
	for (const ex of [9, 13]) {
		setPixel(Math.round(ex - .5), browY, shade(appearance.hairColor, -10));
		setPixel(Math.round(ex + .5), browY, shade(appearance.hairColor, -10));
	}
	const eyeY = Math.round(10);
	setPixel(Math.round(9), eyeY, appearance.eyeColor);
	setPixel(Math.round(13), eyeY, appearance.eyeColor);
	const mouthY = Math.round(13.1);
	const mouthColor = shade(appearance.skinTone, -45);
	if (mood > .25) {
		setPixel(10, mouthY, mouthColor);
		setPixel(HEAD_CX, 14, mouthColor);
		setPixel(12, mouthY, mouthColor);
	} else if (mood < -.25) {
		setPixel(10, 14, mouthColor);
		setPixel(HEAD_CX, mouthY, mouthColor);
		setPixel(12, 14, mouthColor);
	} else {
		setPixel(10, mouthY, mouthColor);
		setPixel(HEAD_CX, mouthY, mouthColor);
		setPixel(12, mouthY, mouthColor);
	}
	setPixel(Math.round(7.8), Math.round(11.5), shade(appearance.skinTone, -6), 160);
	setPixel(Math.round(14.2), Math.round(11.5), shade(appearance.skinTone, -6), 160);
	setPixel(Math.round(14), 25, appearance.accentColor);
	setPixel(Math.round(15), 25, appearance.accentColor);
	ctx.putImageData(img, 0, 0);
}
//#endregion
//#region src/engine/rng.ts
function hashString(input) {
	let h = 1779033703 ^ input.length;
	for (let i = 0; i < input.length; i++) {
		h = Math.imul(h ^ input.charCodeAt(i), 3432918353);
		h = h << 13 | h >>> 19;
	}
	return h >>> 0;
}
function mulberry32(seed) {
	let a = seed >>> 0;
	return function() {
		a |= 0;
		a = a + 1831565813 | 0;
		let t = Math.imul(a ^ a >>> 15, 1 | a);
		t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
		return ((t ^ t >>> 14) >>> 0) / 4294967296;
	};
}
function rngFromSeed(seed) {
	return mulberry32(hashString(seed));
}
function pick(rng, items) {
	return items[Math.floor(rng() * items.length) % items.length];
}
//#endregion
//#region src/engine/appearance.ts
var SKIN_TONES = [
	"#ffe0bd",
	"#f1c27d",
	"#e0ac69",
	"#c68642",
	"#8d5524",
	"#5a3825"
];
var HAIR_COLORS = [
	"#1c1410",
	"#3b2417",
	"#6b4226",
	"#a9642c",
	"#d6b370",
	"#2b2b2b",
	"#8a2b1f"
];
var EYE_COLORS = [
	"#3b2417",
	"#1c1410",
	"#41573c",
	"#3d5a80",
	"#5b4636"
];
var HAIR_STYLES = [
	"short",
	"long",
	"curly",
	"bald",
	"bun"
];
function generateAppearance(seed, accentColor) {
	const rng = rngFromSeed(`appearance:${seed}`);
	return {
		skinTone: pick(rng, SKIN_TONES),
		hairColor: pick(rng, HAIR_COLORS),
		hairStyle: pick(rng, HAIR_STYLES),
		shirtColor: pick(rng, [
			"#3d5a80",
			"#e07a5f",
			"#81b29a",
			"#f2cc8f",
			"#9381ff",
			"#c9184a",
			"#4a5859"
		]),
		eyeColor: pick(rng, EYE_COLORS),
		accentColor
	};
}
var AGENT_SKIN = [
	"#c9d2dc",
	"#b7c3cf",
	"#aebdcc",
	"#d5dce4"
];
var AGENT_SHELL = [
	"#334155",
	"#1e3a5f",
	"#2f3d50",
	"#3b4a5e"
];
var AGENT_SHIRT = [
	"#1e3a5f",
	"#2b4c6f",
	"#334155",
	"#3d5a80",
	"#22405e"
];
function agentAppearance(seed, accentColor) {
	const rng = rngFromSeed(`agent:${seed}`);
	return {
		skinTone: pick(rng, AGENT_SKIN),
		hairColor: pick(rng, AGENT_SHELL),
		hairStyle: "bald",
		shirtColor: pick(rng, AGENT_SHIRT),
		eyeColor: "#0f172a",
		accentColor
	};
}
//#endregion
//#region src/engine/avatarStyles.ts
var ACCENT = "#2563eb";
var PASS = "#00BCD4";
var FAIL = "#E91E63";
var HUMAN_ACCENT = "#5b6474";
var PORTRAIT_W = 26;
var PORTRAIT_H = 30;
function hexRgb(hex) {
	const c = hex.replace("#", "");
	return [
		parseInt(c.slice(0, 2), 16),
		parseInt(c.slice(2, 4), 16),
		parseInt(c.slice(4, 6), 16)
	];
}
/** Paints the padded portrait grid (PORTRAIT_W × PORTRAIT_H) of a human or agent into a 2D context. */
function paintPortrait(ctx, spec) {
	const seedNum = hashString(spec.seed);
	const base = document.createElement("canvas");
	base.width = 22;
	base.height = 28;
	const bctx = base.getContext("2d");
	if (!bctx) return;
	const appearance = spec.style === "agent" ? agentAppearance(spec.seed, ACCENT) : generateAppearance(spec.seed, HUMAN_ACCENT);
	paintAvatar(bctx, {
		appearance,
		mood: 0,
		seed: seedNum
	});
	ctx.clearRect(0, 0, PORTRAIT_W, PORTRAIT_H);
	ctx.drawImage(base, 2, 2);
	if (spec.style !== "agent") return;
	const img = ctx.getImageData(0, 0, PORTRAIT_W, PORTRAIT_H);
	const d = img.data;
	const at = (x, y) => (y * PORTRAIT_W + x) * 4;
	const set = (x, y, hex, alpha = 255) => {
		if (x < 0 || y < 0 || x >= PORTRAIT_W || y >= PORTRAIT_H) return;
		const [r, g, b] = hexRgb(hex);
		const i = at(x, y);
		d[i] = r;
		d[i + 1] = g;
		d[i + 2] = b;
		d[i + 3] = alpha;
	};
	const opaque = (x, y) => x >= 0 && y >= 0 && x < PORTRAIT_W && y < PORTRAIT_H && d[at(x, y) + 3] > 0;
	const cx = 13;
	const cy = 12.5;
	const shell = appearance.hairColor;
	for (let y = 0; y < PORTRAIT_H; y++) for (let x = 0; x < PORTRAIT_W; x++) {
		const dx = (x - cx) / 6.3;
		const dy = (y - cy) / 7.1;
		if (dx * dx + dy * dy <= 1 && y <= 10.1) set(x, y, x < 12 ? "#475569" : shell);
	}
	for (const side of [-1, 1]) {
		const ex = Math.round(cx + side * 6) - (side > 0 ? 1 : 0);
		for (let y = Math.round(10.5); y <= Math.round(13.5); y++) {
			set(ex, y, shell);
			set(ex + (side > 0 ? 1 : -1), y, shell);
		}
		set(ex, Math.round(11.5), ACCENT);
	}
	const visorY = Math.round(12);
	for (let x = Math.round(8.5); x <= Math.round(16.5); x++) {
		set(x, 11, "#1e40af");
		set(x, visorY, ACCENT);
	}
	set(Math.round(9.5), 11, "#93c5fd");
	const variant = seedNum % 3;
	if (variant === 1) {
		const ax = Math.round(15);
		for (let y = 4; y < 7; y++) set(ax, y, shell);
		set(ax, 3, ACCENT);
	} else if (variant === 2) {
		for (let x = Math.round(11); x <= Math.round(14); x++) set(x, 5, "#1e293b");
		for (let x = Math.round(12); x <= Math.round(cx); x++) set(x, 4, "#1e293b");
	}
	const ring1 = [];
	const ring2 = [];
	for (let y = 0; y < PORTRAIT_H; y++) for (let x = 0; x < PORTRAIT_W; x++) {
		if (opaque(x, y)) continue;
		if (opaque(x - 1, y) || opaque(x + 1, y) || opaque(x, y - 1) || opaque(x, y + 1)) ring1.push([x, y]);
	}
	for (const [x, y] of ring1) set(x, y, ACCENT);
	for (let y = 0; y < PORTRAIT_H; y++) for (let x = 0; x < PORTRAIT_W; x++) {
		if (opaque(x, y)) continue;
		if (opaque(x - 1, y) || opaque(x + 1, y) || opaque(x, y - 1) || opaque(x, y + 1)) ring2.push([x, y]);
	}
	for (const [x, y] of ring2) set(x, y, ACCENT, 70);
	ctx.putImageData(img, 0, 0);
}
var portraitCache = /* @__PURE__ */ new Map();
/** The unscaled portrait grid for a human/agent spec (cached by style+seed). */
function portraitGrid(spec) {
	const key = `${spec.style}:${spec.seed}`;
	const hit = portraitCache.get(key);
	if (hit) return hit;
	const c = document.createElement("canvas");
	c.width = PORTRAIT_W;
	c.height = PORTRAIT_H;
	const ctx = c.getContext("2d");
	if (ctx) paintPortrait(ctx, spec);
	portraitCache.set(key, c);
	return c;
}
function systemKind(spec) {
	const k = `${spec.role ?? ""} ${spec.seed}`.toLowerCase();
	if (/\bci\b|(^|[^a-z])ci([^a-z]|$)|pipeline|verifier of attest/.test(k)) return "tower";
	if (/staging|oracle/.test(k)) return "bench";
	if (/flow|dispatch|orchestrat|engine/.test(k)) return "board";
	return "machine";
}
var LIGHT = {
	ink: "#111827",
	ink2: "#5b6474",
	line: "#e3e6eb",
	lineStrong: "#c4cad3",
	surface: "#ffffff",
	body: "#d9dee5",
	bodyDark: "#aeb6c2",
	idle: "#c4cad3"
};
var DARK = {
	ink: "#e5e7eb",
	ink2: "#9aa3b2",
	line: "#2a2f38",
	lineStrong: "#3a414d",
	surface: "#151920",
	body: "#2b313b",
	bodyDark: "#1f242c",
	idle: "#3d4552"
};
function lightColor(s, p) {
	return s === "pass" ? PASS : s === "fail" || s === "error" ? FAIL : p.idle;
}
function rect(ctx, x, y, w, h, fill, stroke, lw = 1.5) {
	ctx.fillStyle = fill;
	ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
	if (stroke) {
		ctx.strokeStyle = stroke;
		ctx.lineWidth = lw;
		ctx.strokeRect(Math.round(x) + .5, Math.round(y) + .5, Math.round(w) - 1, Math.round(h) - 1);
	}
}
/**
* Draws a system object standing on the floor at (cx, baseY), scaled by `s`. Returns the object's top y, so the
* caller can place a bubble or a label above it.
*/
function drawSystemObject(ctx, kind, cx, baseY, s, state, p) {
	ctx.save();
	let top = baseY;
	if (kind === "tower") {
		const lights = state.lights && state.lights.length ? state.lights : new Array(10).fill("idle");
		const rows = Math.ceil(lights.length / 2);
		const w = 52 * s;
		const lh = 9 * s;
		const gap = 4 * s;
		const h = 30 * s + rows * (lh + gap);
		const x = cx - w / 2;
		const y = baseY - h;
		rect(ctx, x - 6 * s, baseY - 6 * s, w + 12 * s, 6 * s, p.bodyDark);
		rect(ctx, x, y, w, h, p.body, state.running || state.active ? ACCENT : p.lineStrong, 1.5);
		lights.forEach((l, i) => {
			const col = i % 2;
			const row = Math.floor(i / 2);
			rect(ctx, x + 8 * s + col * (w / 2 - 4 * s), y + 22 * s + row * (lh + gap), w / 2 - 12 * s, lh, lightColor(l, p));
		});
		const bw = 22 * s;
		rect(ctx, cx - bw / 2, y - 12 * s, bw, 12 * s, state.beacon === "pass" ? PASS : state.beacon === "fail" ? FAIL : p.idle, p.lineStrong, 1);
		top = y - 12 * s;
	} else if (kind === "bench") {
		const lights = state.lights && state.lights.length ? state.lights : new Array(3).fill("idle");
		const w = 130 * s;
		const h = 22 * s;
		const x = cx - w / 2;
		const y = baseY - h - 14 * s;
		rect(ctx, x + 6 * s, y + h, 6 * s, 14 * s, p.bodyDark);
		rect(ctx, x + w - 12 * s, y + h, 6 * s, 14 * s, p.bodyDark);
		rect(ctx, x, y, w, h, p.body, state.active ? ACCENT : p.lineStrong, 1.5);
		const slot = w / lights.length;
		lights.forEach((l, i) => {
			const mx = x + i * slot + slot * .18;
			const mw = slot * .64;
			rect(ctx, mx, y - 24 * s, mw, 20 * s, p.surface, p.lineStrong, 1);
			rect(ctx, mx + 3 * s, y - 21 * s, mw - 6 * s, 14 * s, lightColor(l, p));
			rect(ctx, mx + mw / 2 - 2 * s, y - 4 * s, 4 * s, 4 * s, p.bodyDark);
		});
		top = y - 24 * s;
	} else if (kind === "board") {
		const w = 96 * s;
		const h = 62 * s;
		const x = cx - w / 2;
		const y = baseY - h - 18 * s;
		rect(ctx, x + 10 * s, y + h, 5 * s, 18 * s, p.bodyDark);
		rect(ctx, x + w - 15 * s, y + h, 5 * s, 18 * s, p.bodyDark);
		rect(ctx, x, y, w, h, p.surface, state.active ? ACCENT : p.lineStrong, state.active ? 2 : 1.5);
		for (let i = 0; i < 4; i++) {
			const ry = y + 9 * s + i * 13 * s;
			rect(ctx, x + 8 * s, ry, 8 * s, 8 * s, i === 0 && state.active ? ACCENT : p.idle);
			rect(ctx, x + 22 * s, ry + 2 * s, (w - 34 * s) * (i % 2 ? .7 : .9), 4 * s, p.lineStrong);
		}
		top = y;
	} else {
		const w = 48 * s;
		const h = 44 * s;
		rect(ctx, cx - w / 2, baseY - h, w, h, p.body, state.active ? ACCENT : p.lineStrong, 1.5);
		rect(ctx, cx - 6 * s, baseY - h + 10 * s, 12 * s, 8 * s, state.active ? ACCENT : p.idle);
		top = baseY - h;
	}
	ctx.restore();
	return top;
}
/** "AI · Sonnet" badge for agents; drawn at display resolution (crisp text). */
function drawBadge(ctx, cx, y, model, s, font = "IBM Plex Sans, system-ui, sans-serif") {
	const text = model ? `AI · ${model}` : "AI";
	ctx.save();
	ctx.font = `600 ${Math.max(9, 10 * s)}px ${font}`;
	const w = ctx.measureText(text).width + 8 * s;
	const h = Math.max(13, 15 * s);
	ctx.fillStyle = ACCENT;
	ctx.fillRect(Math.round(cx - w / 2), Math.round(y), Math.round(w), Math.round(h));
	ctx.fillStyle = "#ffffff";
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillText(text, cx, y + h / 2 + .5);
	ctx.restore();
}
/**
* Renders a complete avatar card image (portrait, or system object) into `canvas` at `size` px wide.
* Used by the Teams gallery; the theater draws the same portrait grid and objects on its stage.
*/
function renderAvatar(canvas, spec, size = 96, palette = LIGHT) {
	const h = Math.round(size * PORTRAIT_H / PORTRAIT_W) + (spec.style === "agent" ? Math.round(size * .2) : 0);
	const dpr = typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 2) : 1;
	canvas.width = Math.round(size * dpr);
	canvas.height = Math.round(h * dpr);
	canvas.style.width = `${size}px`;
	canvas.style.height = `${h}px`;
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, size, h);
	ctx.imageSmoothingEnabled = false;
	if (spec.style === "system") {
		const kind = systemKind(spec);
		const s = size / 140;
		drawSystemObject(ctx, kind, size / 2, h - 6 * s, kind === "tower" ? s * .9 : s, { active: false }, palette);
		return;
	}
	const grid = portraitGrid(spec);
	const ph = Math.round(size * PORTRAIT_H / PORTRAIT_W);
	ctx.drawImage(grid, 0, 0, size, ph);
	if (spec.style === "agent") drawBadge(ctx, size / 2, ph - size * .02, spec.badge, size / 96);
}
//#endregion
export { ACCENT, DARK, FAIL, LIGHT, PASS, PORTRAIT_H, PORTRAIT_W, drawBadge, drawSystemObject, paintPortrait, portraitGrid, renderAvatar, systemKind };
