//#region src/engine/identity.ts
var PORTRAIT_W = 40;
var PORTRAIT_H = 48;
function poseKey(p) {
	if (!p) return "n";
	return [
		p.blink ? "b" : "",
		p.mouth === "open" ? "o" : "",
		p.expression ?? "",
		p.look ?? "",
		p.typing ?? 0,
		p.breath ?? 0
	].join(".");
}
var FAMILY_ALIASES = {
	anthropic: "anthropic",
	claude: "anthropic",
	aws: "aws",
	"aws-ai-dlc": "aws",
	kiro: "kiro",
	"ai-sdlc-io": "aisdlc",
	"ai-sdlc.io": "aisdlc",
	aisdlc: "aisdlc",
	"agents-vs-gates": "avg",
	avg: "avg",
	mock: "mock"
};
/**
* The agent's family: explicit `family`, else the model id prefix of the seed ("aws:product-agent"), else the model
* badge ("Mock" → mock, a Claude model → anthropic), else the experiment's own look ("avg").
*/
function agentFamily(spec) {
	const explicit = (spec.family ?? "").toLowerCase().trim();
	if (FAMILY_ALIASES[explicit]) return FAMILY_ALIASES[explicit];
	const prefix = spec.seed.includes(":") ? spec.seed.split(":")[0].toLowerCase() : "";
	if (FAMILY_ALIASES[prefix]) return FAMILY_ALIASES[prefix];
	const badge = (spec.badge ?? "").toLowerCase();
	if (badge.includes("mock")) return "mock";
	if (/claude|opus|sonnet|haiku|fable/.test(badge)) return "anthropic";
	return "avg";
}
/** Lower-case words from the role and the seed's own name ("ai-sdlc-io:test-reviewer" → "test reviewer"). */
function roleText(spec) {
	return `${spec.seed.includes(":") ? spec.seed.slice(spec.seed.indexOf(":") + 1) : spec.seed} ${spec.role ?? ""}`.toLowerCase().replace(/[_\-·/()'.]+/g, " ").replace(/\s+/g, " ").trim();
}
var EMBLEM_RULES = [
	[/\bbug\b|\bfix\b/, "wrench"],
	[/secur|secops|complian|polic|guard/, "shield"],
	[/deploy|pipeline|release/, "rocket"],
	[/monitor|operations|observ|on call|incident/, "pulse"],
	[/devops|platform|infra|\bops\b/, "gear"],
	[/test|verif|quality|\bqa\b/, "check"],
	[/review/, "magnifier"],
	[/architect/, "compass"],
	[/design/, "setsquare"],
	[/spec|requirement|product|intent/, "document"],
	[/plan|task|delivery/, "clipboard"],
	[/research|context|gather/, "book"],
	[/simplif|refactor/, "scissors"],
	[/compos|supervis|orchestr|lead|coordinat/, "nodes"],
	[/general|default|custom/, "chip"],
	[/code|develop|coding|engineer/, "code"]
];
function emblemFor(spec) {
	const t = roleText(spec);
	for (const [re, e] of EMBLEM_RULES) if (re.test(t)) return e;
	return "chip";
}
var GROUP_RULES = [
	[/secur|polic|complian|govern/, "governance"],
	[/release|operator|on call|service owner|\bops\b|sre/, "ops"],
	[/architect/, "architect"],
	[/product|originator|owner|manager/, "product"],
	[/lead|platform|manager|code owner/, "lead"],
	[/engineer|develop|dev/, "dev"]
];
function humanGroup(spec) {
	const t = roleText(spec);
	if (/code owner|tech lead|engineering manager|platform/.test(t)) return "lead";
	for (const [re, g] of GROUP_RULES) if (re.test(t)) return g;
	return "dev";
}
//#endregion
//#region src/engine/pixels.ts
function hex(h) {
	const c = h.replace("#", "");
	return [
		parseInt(c.slice(0, 2), 16),
		parseInt(c.slice(2, 4), 16),
		parseInt(c.slice(4, 6), 16)
	];
}
function mix(a, b, t) {
	return [
		Math.round(a[0] + (b[0] - a[0]) * t),
		Math.round(a[1] + (b[1] - a[1]) * t),
		Math.round(a[2] + (b[2] - a[2]) * t)
	];
}
var WARM_LIGHT = [
	255,
	246,
	228
];
var COOL_SHADE = [
	38,
	30,
	62
];
var INK = [
	24,
	20,
	34
];
function ramp(base, outline = INK, strength = 1) {
	return {
		hi: mix(base, WARM_LIGHT, .24 * strength),
		base,
		mid: mix(base, COOL_SHADE, .17 * strength),
		lo: mix(base, COOL_SHADE, .34 * strength),
		line: mix(base, outline, .66)
	};
}
var PixelGrid = class {
	w;
	h;
	data;
	constructor(w, h) {
		this.w = w;
		this.h = h;
		this.data = new Uint8ClampedArray(w * h * 4);
	}
	inside(x, y) {
		return x >= 0 && y >= 0 && x < this.w && y < this.h;
	}
	set(x, y, c) {
		if (!c || !this.inside(x, y)) return;
		const i = (y * this.w + x) * 4;
		this.data[i] = c[0];
		this.data[i + 1] = c[1];
		this.data[i + 2] = c[2];
		this.data[i + 3] = 255;
	}
	get(x, y) {
		if (!this.inside(x, y)) return null;
		const i = (y * this.w + x) * 4;
		if (this.data[i + 3] === 0) return null;
		return [
			this.data[i],
			this.data[i + 1],
			this.data[i + 2]
		];
	}
	opaque(x, y) {
		return this.inside(x, y) && this.data[(y * this.w + x) * 4 + 3] > 0;
	}
	/** Sets a pixel only where something is already painted (details that must stay inside a shape). */
	over(x, y, c) {
		if (this.opaque(x, y)) this.set(x, y, c);
	}
	/**
	* Paints a shape: every pixel whose centre is inside `mask` gets `fill`, and (when `line` is given) every pixel
	* 4-adjacent to the shape gets the outline colour. Painting parts back to front with their own outline gives the
	* clean separations pixel artists draw by hand (chin over neck, fringe over forehead).
	*/
	shape(mask, fill, line, only) {
		const inMask = new Uint8Array(this.w * this.h);
		for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) if (mask(x + .5, y + .5)) inMask[y * this.w + x] = 1;
		const m = (x, y) => this.inside(x, y) && inMask[y * this.w + x] === 1;
		for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
			if (!m(x, y)) continue;
			if (only && !only(x, y)) continue;
			this.set(x, y, fill(x + .5, y + .5, x, y));
		}
		if (!line) return;
		for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
			if (m(x, y)) continue;
			if (!(m(x - 1, y) || m(x + 1, y) || m(x, y - 1) || m(x, y + 1))) continue;
			if (only && !only(x, y)) continue;
			this.set(x, y, typeof line === "function" ? line(x, y) : line);
		}
	}
	/** Draws a small bitmap: each character maps to a colour through `palette` ('.' and ' ' are transparent). */
	bitmap(x0, y0, rows, palette, flip = false) {
		rows.forEach((row, j) => {
			for (let i = 0; i < row.length; i++) {
				const ch = flip ? row[row.length - 1 - i] : row[i];
				if (ch === "." || ch === " ") continue;
				this.set(x0 + i, y0 + j, palette[ch] ?? null);
			}
		});
	}
	/** Copies another grid on top of this one, offset by (dx, dy). */
	blit(src, dx, dy) {
		for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) {
			const c = src.get(x, y);
			if (c) this.set(x + dx, y + dy, c);
		}
	}
};
/** FNV-1a over the RGBA bytes: the "pixel hash" the determinism tests compare. */
function gridHash(g) {
	let h = 2166136261;
	for (let i = 0; i < g.data.length; i++) {
		h ^= g.data[i];
		h = Math.imul(h, 16777619) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}
/** Ellipse test with an optional superellipse exponent (n = 2 is a plain ellipse). */
function inEllipse(px, py, cx, cy, rx, ry, n = 2) {
	return Math.pow(Math.abs(px - cx) / rx, n) + Math.pow(Math.abs(py - cy) / ry, n) <= 1;
}
/** Axis-aligned rounded rectangle test (inclusive bounds in pixel-centre coordinates). */
function inRoundRect(px, py, x0, y0, x1, y1, r) {
	if (px < x0 || px > x1 || py < y0 || py > y1) return false;
	const cx = Math.min(Math.max(px, x0 + r), x1 - r);
	const cy = Math.min(Math.max(py, y0 + r), y1 - r);
	const dx = px - cx;
	const dy = py - cy;
	return dx * dx + dy * dy <= r * r + .01;
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
//#region src/engine/human.ts
var CX$1 = 20;
var SKINS = [
	"#fde3c8",
	"#f6d0b1",
	"#eab98f",
	"#d9a172",
	"#c08353",
	"#9a6239",
	"#74472a",
	"#4f2f1d"
];
var HAIR = [
	"#1d1a1c",
	"#1d1a1c",
	"#2e211b",
	"#2e211b",
	"#4a3020",
	"#4a3020",
	"#6e4a2f",
	"#8c3f22",
	"#b8612d",
	"#a3804a",
	"#d8b46a",
	"#9a9a9e",
	"#d9d8d6"
];
var EYES = [
	"#3b2417",
	"#21160f",
	"#4a6a3f",
	"#3e6a96",
	"#6b5532",
	"#4d5a66"
];
var DEEP_EYES = [
	"#3b2417",
	"#21160f",
	"#2a1a12",
	"#5a4126"
];
var SCARVES = [
	"#5d3a5e",
	"#2f4f6b",
	"#5e6b3a",
	"#a8532e",
	"#3d3d4a",
	"#7b6a93",
	"#b59d72",
	"#1f5f63"
];
var CLOTH = {
	navy: "#2c3e5c",
	slate: "#4a5568",
	charcoal: "#34373e",
	olive: "#5e6b3a",
	maroon: "#7a2e3a",
	teal: "#1f5f63",
	mustard: "#c39a3a",
	beige: "#cbb69a",
	heather: "#9aa0a8",
	cream: "#e6dfcf",
	denim: "#4d6f96",
	forest: "#2f5d46",
	rust: "#a8532e",
	plum: "#5d3a5e",
	sky: "#a9c4de",
	white: "#f2f1ec",
	black: "#26272b",
	khaki: "#8f8461"
};
var SHIRTS = [
	"#f2f1ec",
	"#c9dbee",
	"#d8d3ea",
	"#d6e4d2",
	"#efe6d2",
	"#e3e6ea"
];
var HAIR_STYLES = [
	"buzz",
	"short",
	"short",
	"sidepart",
	"sidepart",
	"quiff",
	"curly",
	"curly",
	"afro",
	"bob",
	"long",
	"long",
	"ponytail",
	"bun",
	"braids",
	"hijab",
	"bald"
];
var OUTFITS = {
	dev: [
		"hoodie",
		"hoodie",
		"tee",
		"tee",
		"zip"
	],
	lead: [
		"shirt",
		"polo",
		"sweater",
		"cardigan",
		"zip"
	],
	product: [
		"blazer",
		"blazer",
		"sweater",
		"turtleneck",
		"shirt"
	],
	architect: [
		"blazer",
		"turtleneck",
		"shirt",
		"sweater"
	],
	ops: [
		"vest",
		"vest",
		"polo",
		"zip"
	],
	governance: [
		"suit",
		"suit",
		"blazer"
	]
};
var OUTFIT_COLORS = {
	tee: [
		"navy",
		"olive",
		"maroon",
		"heather",
		"forest",
		"rust",
		"charcoal",
		"mustard",
		"denim"
	],
	hoodie: [
		"charcoal",
		"heather",
		"navy",
		"forest",
		"maroon",
		"olive",
		"plum",
		"black"
	],
	zip: [
		"slate",
		"navy",
		"olive",
		"charcoal",
		"rust",
		"forest"
	],
	shirt: [
		"white",
		"sky",
		"white"
	],
	polo: [
		"navy",
		"forest",
		"maroon",
		"slate",
		"khaki",
		"white"
	],
	sweater: [
		"mustard",
		"forest",
		"maroon",
		"navy",
		"heather",
		"beige",
		"plum"
	],
	turtleneck: [
		"black",
		"charcoal",
		"cream",
		"olive",
		"maroon"
	],
	cardigan: [
		"heather",
		"beige",
		"olive",
		"navy",
		"plum"
	],
	blazer: [
		"navy",
		"charcoal",
		"beige",
		"slate",
		"khaki",
		"black",
		"plum"
	],
	suit: [
		"charcoal",
		"navy",
		"black",
		"slate"
	],
	vest: [
		"olive",
		"khaki",
		"navy",
		"charcoal",
		"rust"
	]
};
function inFace(f, px, py) {
	const dy = py - f.cy;
	return inEllipse(px, py, CX$1, f.cy, f.rx, f.ry, dy < 0 ? 2.15 : f.jawN);
}
function weighted(rng, items) {
	return pick(rng, items);
}
function skinRamp(c) {
	return {
		hi: mix(c, [
			255,
			240,
			225
		], .3),
		base: c,
		mid: mix(c, [
			96,
			36,
			40
		], .2),
		lo: mix(c, [
			72,
			24,
			36
		], .36),
		line: mix(c, [
			40,
			16,
			12
		], .62)
	};
}
function chooseLook(spec, cy) {
	const rng = rngFromSeed(`human-v2:${spec.seed}`);
	const group = humanGroup(spec);
	const skinIdx = Math.floor(rng() * SKINS.length);
	const skinC = hex(SKINS[skinIdx]);
	const hairStyle = weighted(rng, HAIR_STYLES);
	let hairC = hex(pick(rng, HAIR));
	if (hairC[0] > 200 && skinC[0] > 240 && rng() < .5) hairC = hex("#a3804a");
	const face = {
		cy,
		rx: pick(rng, [
			7.6,
			8,
			8,
			8.4
		]),
		ry: pick(rng, [
			9.7,
			10,
			10.3
		]),
		jawN: pick(rng, [
			1.75,
			2,
			2,
			2.6
		])
	};
	const grey = hairC[0] > 140 && Math.abs(hairC[0] - hairC[2]) < 12;
	const fh = rng();
	const facialHair = hairStyle === "hijab" || fh < .62 ? "none" : fh < .72 ? "stubble" : fh < .8 ? "mustache" : fh < .88 ? "goatee" : "beard";
	const glassesP = group === "architect" ? .6 : .28;
	const glasses = rng() < glassesP ? {
		frame: hex(pick(rng, [
			"#1f2329",
			"#1f2329",
			"#5a3b26",
			"#3e4c66",
			"#9aa3ad",
			"#7a2e3a"
		])),
		round: rng() < .4
	} : null;
	const earring = ![
		"bob",
		"long",
		"hijab",
		"afro",
		"braids"
	].includes(hairStyle) && rng() < .3 ? hex(pick(rng, ["#e3b341", "#cfd6de"])) : null;
	const outfit = pick(rng, OUTFITS[group]);
	const clothC = hex(CLOTH[pick(rng, OUTFIT_COLORS[outfit])]);
	let innerC;
	if (outfit === "blazer" || outfit === "suit") innerC = hex(pick(rng, outfit === "suit" ? SHIRTS : [
		...SHIRTS,
		CLOTH.black,
		CLOTH.cream,
		CLOTH.heather
	]));
	else if (outfit === "vest" || outfit === "cardigan") innerC = hex(pick(rng, [
		CLOTH.white,
		CLOTH.heather,
		CLOTH.sky,
		CLOTH.cream,
		CLOTH.charcoal
	]));
	else if (outfit === "sweater") innerC = hex(pick(rng, SHIRTS));
	else innerC = clothC;
	const tie = outfit === "suit" && rng() < .6 ? ramp(hex(pick(rng, [
		"#7a2e3a",
		"#2c3e5c",
		"#5e6b3a",
		"#3d3d4a",
		"#8f6b2e"
	]))) : null;
	const lanyard = group === "ops" ? rng() < .75 : group === "governance" ? rng() < .5 : rng() < .12;
	return {
		skin: skinRamp(skinC),
		hair: ramp(hairC, [
			16,
			10,
			14
		]),
		hairStyle,
		eye: hex(skinIdx >= 4 ? pick(rng, DEEP_EYES) : pick(rng, EYES)),
		face,
		side: rng() < .5 ? 1 : -1,
		sideburn: pick(rng, [
			0,
			.8,
			1.6
		]),
		browStyle: Math.floor(rng() * 3),
		nose: Math.floor(rng() * 3),
		mouthW: pick(rng, [
			4,
			4,
			6
		]),
		facialHair,
		glasses,
		earring,
		blush: rng() < .35,
		lines: grey,
		outfit,
		cloth: ramp(clothC),
		inner: ramp(innerC),
		lanyard,
		tie,
		scarf: ramp(hex(pick(rng, SCARVES))),
		print: Math.floor(rng() * 4)
	};
}
function torsoTop(dx) {
	const a = Math.abs(dx);
	return 34 + Math.pow(Math.max(0, a - 4.5), 2) / 26 + (a > 15.4 ? (a - 15.4) * 1.4 : 0);
}
function inTorso(px, py) {
	const dx = px - CX$1;
	return Math.abs(dx) <= 17.6 && py >= torsoTop(dx);
}
function clothFill(r) {
	return (px, py) => {
		const dx = px - CX$1;
		const a = Math.abs(dx);
		if (a > 12.4 && a < 13.4 && py > 40.5) return r.lo;
		if (dx > 13.4) return py > 41 ? r.lo : r.mid;
		if (dx > 8.5) return r.mid;
		if (dx < -12.4 && py < 40) return r.hi;
		return r.base;
	};
}
function paintBody(g, L) {
	const c = L.cloth;
	g.shape(inTorso, clothFill(c), c.line);
	const set = (x, y, col) => g.over(x, y, col);
	const vOpen = (py, top = 34, width = 3.4, slope = .5) => width - (py - top) * slope;
	const o = L.outfit;
	if (o === "blazer" || o === "suit") {
		for (let y = 33; y < 48; y++) for (let x = 10; x < 30; x++) {
			const px = x + .5;
			const py = y + .5;
			const a = Math.abs(px - CX$1);
			const v = vOpen(py, 34, 3.6, .42);
			if (py >= 34 && a <= v) set(x, y, a > v - 1 && L.inner.base[0] > 200 ? L.inner.mid : L.inner.base);
			else if (py >= 34 && py < 43 && a <= v + 1) set(x, y, c.line);
			else if (py >= 34 && py < 42 && a <= v + 3.2) set(x, y, a <= v + 2 ? c.hi : c.base);
			else if (py >= 42 && a < .6) set(x, y, c.line);
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
		if (o === "blazer" && L.print === 2) {
			set(11, 40, L.inner.base);
			set(12, 40, L.inner.base);
			set(13, 40, c.line);
		}
	} else if (o === "hoodie" || o === "zip") {
		if (o === "zip") {
			for (let y = 35; y < 48; y++) set(19, y, c.line);
			for (let y = 35; y < 48; y++) set(20, y, c.hi);
			set(20, 38, hex("#cfd6de"));
			set(20, 39, hex("#cfd6de"));
		} else {
			for (let y = 37; y < 42; y++) {
				set(17, y, L.inner.hi);
				set(22, y, L.inner.hi);
			}
			set(17, 42, c.line);
			set(22, 42, c.line);
			for (let x = 13; x <= 26; x++) set(x, 44, c.lo);
			set(12, 45, c.lo);
			set(27, 45, c.lo);
		}
	} else if (o === "tee") {
		if (L.print === 1) for (let x = 15; x <= 24; x++) {
			set(x, 40, c.hi);
			set(x, 41, c.hi);
		}
		if (L.print === 2) for (let y = 39; y < 43; y++) for (let x = 16; x <= 23; x++) set(x, y, (x + y) % 2 ? c.hi : c.mid);
	} else if (o === "sweater") for (let x = 4; x < 36; x++) set(x, 46, c.mid);
	else if (o === "cardigan" || o === "vest") {
		const inner = L.inner;
		const open = o === "vest" ? 3.2 : 2.6;
		const armless = o === "vest";
		for (let y = 33; y < 48; y++) for (let x = 2; x < 38; x++) {
			const px = x + .5;
			const py = y + .5;
			if (!inTorso(px, py)) continue;
			const a = Math.abs(px - CX$1);
			if (a < open - (py < 38 ? 0 : 0)) set(x, y, a > open - 1.2 ? inner.mid : inner.base);
			else if (a < open + 1) set(x, y, c.line);
			else if (armless && a > 12.4) set(x, y, a > 13.4 && px > CX$1 ? inner.mid : inner.base);
			else if (armless && a > 11.4) set(x, y, c.line);
		}
		if (o === "vest") for (const sx of [-1, 1]) {
			for (let x = 0; x < 4; x++) set(CX$1 + sx * 6 + (sx > 0 ? x : -x - 1), 42, c.line);
			set(CX$1 + sx * 6 + (sx > 0 ? 0 : -1), 43, c.line);
			set(CX$1 + sx * 9 + (sx > 0 ? 0 : -1), 43, c.line);
		}
		else for (const y of [
			39,
			42,
			45
		]) set(16, y, c.hi);
	}
}
function paintNeck$1(g, L, f) {
	const s = L.skin;
	const o = L.outfit;
	const deep = o === "tee" || o === "hoodie" || o === "blazer" ? 2.4 : 1.4;
	g.shape((px, py) => Math.abs(px - CX$1) <= 3.1 && py > f.cy + 4 && py < 36 || py >= 33.5 && inEllipse(px, py, CX$1, 33.6, 4.4, deep), (px, py) => py < f.cy + f.ry + 2.2 ? s.lo : px - CX$1 > 1.4 ? s.lo : s.mid, (_x, y) => y >= 34 ? L.cloth.line : s.line);
	if (o === "turtleneck") g.shape((px, py) => Math.abs(px - CX$1) <= 4.6 && py > f.cy + f.ry - 1 && py < 36.5, (px) => Math.floor(px) % 2 === 0 ? L.cloth.base : L.cloth.mid, L.cloth.line);
	else if (o === "zip") g.shape((px, py) => Math.abs(px - CX$1) <= 4.4 && py > f.cy + f.ry + .2 && py < 35.5 && Math.abs(px - CX$1) > .4, (px) => px < CX$1 ? L.cloth.hi : L.cloth.base, L.cloth.line);
	else if (o === "hoodie") for (let y = 31; y < 37; y++) for (let x = 10; x < 30; x++) {
		const px = x + .5;
		const py = y + .5;
		const a = Math.abs(px - CX$1);
		if (inEllipse(px, py, CX$1, 34.2, 8.2, 3.2) && !inEllipse(px, py, CX$1, 33.6, 4.6, 2.6) && py > 32.6) g.set(x, y, a > 7 ? L.cloth.line : px > CX$1 ? L.cloth.mid : L.cloth.hi);
	}
	else if (o === "shirt" || o === "polo" || o === "sweater" || o === "suit" || o === "blazer" && L.inner.base[0] > 200) {
		const col = o === "shirt" || o === "polo" ? L.cloth : L.inner;
		const k = col.line;
		const w = col.base;
		const l = col.mid;
		g.bitmap(13, 32, [
			"...kk....kk...",
			"..kwwk..kwwk..",
			"..kwwwkkwwwk..",
			"...kwwwwwwlk..",
			"....kkwwlkk...",
			"......kk......"
		], {
			k,
			w,
			l
		});
		if (o === "shirt") {
			for (let y = 38; y < 48; y++) g.over(19, y, col.mid);
			for (const y of [
				39,
				42,
				45
			]) g.over(20, y, col.line);
		} else if (o === "polo") {
			for (let y = 37; y < 41; y++) g.over(19, y, col.mid);
			g.over(20, 38, col.line);
			g.over(20, 40, col.line);
		}
	} else if (o === "tee" || o === "cardigan" || o === "vest") for (let x = 14; x < 26; x++) for (let y = 33; y < 38; y++) {
		const px = x + .5;
		const py = y + .5;
		if (!g.opaque(x, y)) continue;
		if (!inEllipse(px, py, CX$1, 33.6, 4.4, o === "tee" ? 2.4 : 1.4) && inEllipse(px, py, CX$1, 33.6, 5.5, (o === "tee" ? 2.4 : 1.4) + 1.1) && py > 33.4) g.set(x, y, o === "tee" ? L.cloth.mid : L.inner.mid);
	}
	if (L.lanyard) {
		const strap = hex("#4b5361");
		for (const [x, y] of [
			[16, 36],
			[16, 37],
			[17, 38],
			[17, 39],
			[18, 40],
			[23, 36],
			[23, 37],
			[22, 38],
			[22, 39],
			[21, 40]
		]) g.over(x, y, strap);
		g.bitmap(17, 41, [
			"kkkkkk",
			"kbbbbk",
			"kwwwwk",
			"kwkkwk",
			"kwwwwk",
			"kkkkkk"
		], {
			k: hex("#3a404b"),
			b: hex("#5b6474"),
			w: hex("#f4f5f7")
		});
	}
}
function paintEars$1(g, L, f) {
	const s = L.skin;
	for (const sx of [-1, 1]) {
		const ex = CX$1 + sx * (f.rx + .2);
		g.shape((px, py) => inEllipse(px, py, ex, f.cy + 1.3, 1.8, 2.7), (px) => (px - ex) * sx > .2 ? s.base : s.mid, s.line);
		const ix = Math.floor(ex + sx * .2);
		g.over(ix, Math.floor(f.cy + 1), s.lo);
		g.over(ix, Math.floor(f.cy + 2), s.lo);
		if (L.earring) {
			g.set(Math.floor(ex), Math.floor(f.cy + 4.2), L.earring);
			if (L.print % 2 === 0) g.set(Math.floor(ex), Math.floor(f.cy + 5.2), L.earring);
		}
	}
}
function paintHead$1(g, L, f, clip) {
	const s = L.skin;
	g.shape((px, py) => inFace(f, px, py) && (!clip || clip(px, py)), (px, py) => {
		const dx = px - CX$1;
		const dy = py - f.cy;
		const edgeR = !inFace(f, px + 1.6, py);
		const edgeB = dy > f.ry * .45 && !inFace(f, px, py + 1.4);
		if (edgeR && dy > -f.ry * .7) return s.mid;
		if (edgeB) return s.mid;
		if (dx > f.rx - 3.4 && dy > .5 && dy < 5) return s.mid;
		if (dx < -2 && dx > -f.rx + 1.4 && dy < -f.ry * .38 && dy > -f.ry * .8) return s.hi;
		if (dx < -f.rx + 3 && dx > -f.rx + 1.2 && dy > .2 && dy < 3.4) return s.hi;
		return s.base;
	}, s.line);
}
function paintFeatures(g, L, f, pose) {
	const s = L.skin;
	const cy = Math.round(f.cy);
	const lid = cy - 1;
	const lash = mix(s.line, [
		12,
		8,
		10
	], .45);
	const white = [
		244,
		239,
		232
	];
	const iris = L.eye;
	const pupil = mix(L.eye, [
		8,
		6,
		10
	], .65);
	const hl = [
		255,
		255,
		255
	];
	const expr = pose.expression ?? "neutral";
	const n = L.nose;
	g.over(21, cy + 2, s.mid);
	g.over(21, cy + 3, s.mid);
	if (n === 1) g.over(21, cy + 1, s.mid);
	g.over(19, cy + 2, s.hi);
	g.over(19, cy + 4, s.mid);
	g.over(20, cy + 4, s.lo);
	g.over(21, cy + 4, s.lo);
	if (n === 2) {
		g.over(18, cy + 4, s.mid);
		g.over(22, cy + 4, s.mid);
	}
	const h = L.hair;
	if (L.facialHair === "stubble" || L.facialHair === "beard") {
		for (let y = cy + 2; y < 48; y++) for (let x = 8; x < 32; x++) {
			const px = x + .5;
			const py = y + .5;
			if (!inFace(f, px, py)) continue;
			const dx = Math.abs(px - CX$1);
			if (!(py > f.cy + 4.6 || dx > f.rx - 2.4 && py > f.cy + 1.5)) continue;
			if (L.facialHair === "stubble") {
				if ((x + y) % 2 === 0) g.set(x, y, mix(g.get(x, y) ?? s.base, h.base, .38));
			} else g.set(x, y, dx > f.rx - 2 ? h.mid : (x + y * 2) % 5 === 0 ? h.hi : h.base);
		}
		if (L.facialHair === "beard") g.shape((px, py) => inFace({
			...f,
			ry: f.ry + 1.2,
			rx: f.rx - .2
		}, px, py) && !inFace(f, px, py) && py > f.cy + 4, () => h.mid, h.line);
	}
	const mw = L.mouthW;
	const mx0 = CX$1 - mw / 2;
	const mx1 = CX$1 + mw / 2 - 1;
	const my = cy + 6;
	if (L.facialHair === "mustache" || L.facialHair === "goatee" || L.facialHair === "beard") for (let x = mx0 - 1; x <= mx1 + 1; x++) g.over(x, my - 1, x === mx0 - 1 || x === mx1 + 1 ? h.mid : h.base);
	if (L.facialHair === "goatee") for (let y = my + 2; y <= my + 4; y++) for (let x = 18; x <= 21; x++) g.over(x, y, y === my + 4 ? h.mid : h.base);
	const deep = s.base[0] * .3 + s.base[1] * .59 + s.base[2] * .11 < 120;
	const lip = deep ? mix(s.line, [
		140,
		56,
		66
	], .28) : mix(s.lo, [
		110,
		30,
		46
	], .45);
	const lipLight = mix(s.base, [
		196,
		96,
		100
	], .22);
	if (pose.mouth === "open") {
		for (let x = mx0; x <= mx1; x++) g.over(x, my, lip);
		for (let x = mx0 + 1; x <= mx1 - 1; x++) g.over(x, my + 1, [
			70,
			24,
			32
		]);
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
		for (let x = mx0; x <= mx1; x++) g.over(x, my, x === mx0 || x === mx1 ? mix(lip, s.base, .4) : lip);
		for (let x = mx0 + 1; x <= mx1 - 1; x++) g.over(x, my + 1, lipLight);
	}
	if (L.lines) {
		g.over(16, cy + 5, s.mid);
		g.over(23, cy + 5, s.mid);
	}
	if (L.blush) {
		g.over(15, cy + 3, mix(s.base, [
			214,
			110,
			110
		], .22));
		g.over(24, cy + 3, mix(s.base, [
			214,
			110,
			110
		], .22));
	}
	for (const side of [-1, 1]) {
		const x0 = side < 0 ? 14 : 22;
		const at = (i) => side < 0 ? x0 + i : x0 + 3 - i;
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
			g.over(at(1), lid + 1, up ? iris : white);
			g.over(at(2), lid + 1, side < 0 ? up ? hl : iris : hl);
			g.over(at(3), lid + 1, side < 0 ? hl : up ? hl : iris);
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
	const brow = L.hairStyle === "bald" || L.hairStyle === "buzz" || L.hairStyle === "hijab" ? mix(L.hair.base, s.line, .35) : L.hair.base[0] > 150 ? mix(L.hair.base, s.line, .5) : mix(L.hair.base, [
		10,
		6,
		8
	], .2);
	const browC = deep ? mix(brow, [
		8,
		4,
		4
	], .45) : brow;
	const by = lid - 2 - (expr === "happy" ? 1 : 0);
	for (const side of [-1, 1]) {
		const at = (i) => side < 0 ? 13 + i : 26 - i;
		for (let i = 0; i < 5; i++) {
			let y = by;
			if (L.browStyle === 1 && i === 0) y += 1;
			if (expr === "worried" && i >= 3) y -= 1;
			g.over(at(i), y, browC);
			if (L.browStyle === 2 && i >= 1 && i <= 3) g.over(at(i), y + 1, browC);
		}
	}
	if (L.glasses) {
		const fr = L.glasses.frame;
		for (const side of [-1, 1]) {
			const x0 = side < 0 ? 13 : 21;
			for (let x = x0; x <= x0 + 5; x++) if (!(L.glasses.round && (x === x0 || x === x0 + 5))) {
				g.set(x, lid - 1, fr);
				g.set(x, lid + 3, fr);
			}
			for (let y = lid - 1 + (L.glasses.round ? 1 : 0); y <= lid + 3 - (L.glasses.round ? 1 : 0); y++) {
				g.set(x0, y, fr);
				g.set(x0 + 5, y, fr);
			}
			g.set(x0 + 1, lid, mix(g.get(x0 + 1, lid) ?? s.base, [
				255,
				255,
				255
			], .55));
			const tx = side < 0 ? x0 - 1 : x0 + 6;
			g.over(tx, lid, fr);
			g.over(side < 0 ? tx - 1 : tx + 1, lid, fr);
		}
		g.set(19, lid, fr);
		g.set(20, lid, fr);
	}
}
function hairFill(L, f, curly) {
	const h = L.hair;
	return (px, py, x, y) => {
		const dx = px - CX$1;
		const top = f.cy - f.ry;
		const d = Math.hypot(px - 23, py - (f.cy + 3));
		if (curly) {
			if ((x * 3 + y * 5) % 7 === 0) return h.hi;
			if ((x * 5 + y * 3) % 6 === 0 || dx > f.rx - 1) return h.mid;
			return h.base;
		}
		if (dx < -1 && py < f.cy - 2 && Math.abs(d - (f.ry + 2.2)) < .75) return h.hi;
		if (dx > f.rx - 1.5 || py > f.cy + 1) return h.mid;
		if (py < top + .5 && dx > 2) return h.mid;
		return h.base;
	};
}
function hairLine(L, f) {
	return (x, y) => {
		if (inFace(f, x + .5, y + .5)) return mix(L.skin.lo, L.hair.base, .35);
		return L.hair.line;
	};
}
function hairline(L, f, dx) {
	const a = Math.abs(dx);
	if (a > f.rx - 2.3) return f.cy + L.sideburn - .4;
	return f.cy - 5.7 + Math.pow(a / f.rx, 2) * 1.8;
}
function cap(L, f, grow, lift, line) {
	return (px, py) => {
		const dx = px - CX$1;
		const top = py < f.cy;
		return inEllipse(px, py, CX$1, f.cy - .4, f.rx + grow, f.ry + grow + (top ? lift : 0)) && py < (line ? line(px, py) : hairline(L, f, dx));
	};
}
function bumpy(px, py, cx, cy, rx, ry, freq, amp, phase) {
	const ang = Math.atan2(py - cy, px - cx);
	const k = 1 + amp * Math.sin(freq * ang + phase);
	return inEllipse(px, py, cx, cy, rx * k, ry * k);
}
function paintHairBack(g, L, f) {
	const h = L.hair;
	const st = L.hairStyle;
	const fill = hairFill(L, f, st === "afro");
	if (st === "afro") g.shape((px, py) => bumpy(px, py, CX$1, f.cy - 2.6, f.rx + 5.4, f.ry + 3.4, 11, .055, L.side), hairFill(L, f, true), h.line);
	else if (st === "bob") g.shape((px, py) => {
		const dx = Math.abs(px - CX$1);
		if (inEllipse(px, py, CX$1, f.cy - .6, f.rx + 2.4, f.ry + 2)) return py < f.cy + 7.2;
		return dx <= f.rx + 2.4 && py >= f.cy - .6 && py < f.cy + 7.2 - (dx > f.rx + 1.4 ? 0 : 0);
	}, (px, py, x, y) => py > f.cy + 6 ? h.mid : fill(px, py, x, y), h.line);
	else if (st === "long") g.shape((px, py) => {
		const dx = Math.abs(px - CX$1);
		if (inEllipse(px, py, CX$1, f.cy - .6, f.rx + 2.6, f.ry + 2.2)) return true;
		const w = f.rx + 2.6 + Math.max(0, py - f.cy - 5) * .28;
		return py >= f.cy - .6 && py < 41.5 - Math.floor(px) % 2 && dx <= w;
	}, (px, py, x, y) => py > f.cy + 3 ? Math.floor(px) % 3 === 0 ? h.mid : h.base : fill(px, py, x, y), h.line);
	else if (st === "ponytail") {
		const tx = CX$1 + L.side * 10.2;
		g.shape((px, py) => inEllipse(px, py, tx, f.cy + 1.6, 2.1, 6.2) && py > f.cy - 5, (px) => (px - tx) * L.side > .6 ? h.mid : h.base, h.line);
	} else if (st === "braids") g.shape((px, py) => inEllipse(px, py, CX$1, f.cy - .6, f.rx + 1.6, f.ry + 1.6), fill, h.line);
}
function paintHairFront(g, L, f) {
	const h = L.hair;
	const st = L.hairStyle;
	const line = hairLine(L, f);
	const fill = hairFill(L, f, st === "curly");
	switch (st) {
		case "bald":
			g.over(15, Math.round(f.cy - f.ry + 2), L.skin.hi);
			g.over(16, Math.round(f.cy - f.ry + 2), L.skin.hi);
			g.over(16, Math.round(f.cy - f.ry + 1), L.skin.hi);
			if (L.side > 0) g.shape((px, py) => Math.abs(px - CX$1) > f.rx - 1.2 && py > f.cy - 3.2 && py < f.cy + .6 && inEllipse(px, py, CX$1, f.cy - .4, f.rx + .8, f.ry + .8), () => h.mid, h.line);
			break;
		case "buzz":
			g.shape(cap(L, f, .55, 0), (_px, _py, x, y) => (x + 2 * y) % 4 === 0 ? mix(h.base, L.skin.base, .3) : h.base, (x, y) => inFace(f, x + .5, y + .5) ? mix(L.skin.mid, h.base, .25) : mix(h.line, L.skin.line, .3));
			break;
		case "short":
			g.shape(cap(L, f, 1.3, 1.2, (px) => hairline(L, f, px - CX$1) + (Math.floor(px) % 3 === 0 ? .9 : 0)), fill, line);
			break;
		case "sidepart": {
			const s = L.side;
			g.shape(cap(L, f, 1.4, 1.9, (px) => {
				const dx = px - CX$1;
				if (Math.abs(dx) > f.rx - 2.3) return hairline(L, f, dx);
				return f.cy - 6.4 + Math.max(0, -s * dx + 3) * .34;
			}), fill, line);
			for (let y = Math.floor(f.cy - f.ry - 2); y < f.cy - 6; y++) g.over(CX$1 + s * 3 - (s > 0 ? 0 : 1), y, h.lo);
			break;
		}
		case "quiff":
			g.shape((px, py) => cap(L, f, 1, .6)(px, py) || inEllipse(px, py, CX$1 - L.side * 2, f.cy - f.ry - .2, 5.6, 3.2), fill, line);
			break;
		case "curly":
			g.shape((px, py) => bumpy(px, py, CX$1, f.cy - 1.2, f.rx + 2.2, f.ry + 2.6, 9, .07, L.side) && py < (Math.abs(px - CX$1) > f.rx - 2.2 ? f.cy + 3 : f.cy - 5.2 + (Math.floor(px) % 2 ? .9 : 0)), fill, line);
			break;
		case "afro":
			g.shape((px, py) => inFace(f, px, py) && py < hairline(L, f, px - CX$1) + .4, hairFill(L, f, true), line);
			break;
		case "bob":
			g.shape((px, py) => {
				const dx = Math.abs(px - CX$1);
				if (!inEllipse(px, py, CX$1, f.cy - .6, f.rx + 2.4, f.ry + 2)) return dx > f.rx - 1.6 && dx <= f.rx + 2.4 && py < f.cy + 7.2 && py > f.cy - 2;
				if (dx > f.rx - 1.6) return py < f.cy + 7.2;
				return py < f.cy - 3.6 - (Math.floor(px) % 2 ? 0 : .3);
			}, fill, line);
			break;
		case "long":
		case "braids":
		case "ponytail":
		case "bun": {
			const tight = st === "ponytail" || st === "bun";
			g.shape(cap(L, f, tight ? .8 : 1.2, tight ? .4 : .9, (px) => {
				const dx = px - CX$1;
				if (Math.abs(dx) > f.rx - 2.3) return st === "long" ? f.cy + 9 : hairline(L, f, dx);
				return f.cy - 5.9 + Math.pow(Math.abs(dx) / f.rx, 2) * 2.4 + (st === "long" ? Math.max(0, 2.4 - Math.abs(dx)) * 0 : 0);
			}), fill, line);
			if (st !== "ponytail") for (let y = Math.floor(f.cy - f.ry - 1); y < f.cy - 6.4; y++) g.over(19, y, h.lo);
			if (st === "bun") {
				const bx = 19.5 + (L.print % 2 ? 0 : L.side * 1.5);
				g.shape((px, py) => inEllipse(px, py, bx, f.cy - f.ry - 2.2, 3.5, 3.1), fill, h.line);
				g.over(Math.floor(bx) - 1, Math.floor(f.cy - f.ry - 3), h.hi);
			}
			if (st === "ponytail") {
				const tx = Math.floor(CX$1 + L.side * 8.6);
				g.set(tx, Math.floor(f.cy - 4), hex("#5b6474"));
				g.set(tx, Math.floor(f.cy - 3), hex("#5b6474"));
			}
			break;
		}
	}
}
/** Long-hair strands and braids that fall in front of the shoulders (drawn after the body). */
function paintHairOverBody(g, L, f) {
	const h = L.hair;
	if (L.hairStyle === "braids") for (const sx of [-1, 1]) {
		const x0 = CX$1 + sx * (f.rx + 1.1);
		g.shape((px, py) => Math.abs(px - x0) <= 1.6 && py > f.cy - 1 && py < 43.5, (_px, _py, x, y) => (y + x % 2) % 2 === 0 ? h.base : h.mid, h.line);
		const bx = Math.floor(x0 - .5);
		g.set(bx, 44, hex("#5b6474"));
		g.set(bx + 1, 44, hex("#5b6474"));
	}
	else if (L.hairStyle === "long") for (const sx of [-1, 1]) g.shape((px, py) => {
		const dx = (px - CX$1) * sx;
		return dx > f.rx - .8 && dx < f.rx + 3.4 + Math.max(0, py - 33) * .2 && py > f.cy + 4 && py < 41 - (Math.floor(px) + 1) % 2;
	}, (px) => Math.floor(px) % 3 === 0 ? h.mid : h.base, h.line);
}
function paintHijab(g, L, f) {
	const c = L.scarf;
	g.shape((px, py) => {
		const dx = Math.abs(px - CX$1);
		if (inEllipse(px, py, CX$1, f.cy, f.rx + 3.2, f.ry + 3)) return true;
		const w = f.rx + 3.2 + Math.max(0, py - f.cy - 3) * .55;
		return py >= f.cy && py < 39.5 - (dx > 9 ? (dx - 9) * 1.2 : 0) && dx <= Math.min(w, 12.5);
	}, (px, py) => {
		const dx = px - CX$1;
		if (dx > f.rx) return c.mid;
		if (py > f.cy + f.ry + 1 && Math.abs(dx) < 6 && Math.floor(py) % 3 === 0) return c.mid;
		if (dx < -f.rx + 1 && py < f.cy) return c.hi;
		return c.base;
	}, c.line);
}
function inOpening(f) {
	return (px, py) => inEllipse(px, py, CX$1, f.cy + 1.2, f.rx - .6, f.ry - 1.4);
}
function paintTyping$1(g, L, frame) {
	const kb = ramp(hex("#d5dae1"), [
		40,
		46,
		60
	]);
	g.shape((px, py) => px > 8 && px < 32 && py > 44.4, (_px, py, x) => py < 45.5 ? kb.hi : x % 3 === 0 ? kb.mid : kb.base, kb.line);
	const s = L.skin;
	for (const sx of [-1, 1]) {
		const up = sx < 0 && frame === 1 || sx > 0 && frame === 2 ? 1 : 0;
		const hx = CX$1 + sx * 6.5;
		g.shape((px, py) => inEllipse(px, py, hx, 44.2 - up, 2.3, 1.6), (px) => (px - hx) * sx > .5 ? s.mid : s.base, s.line);
		g.shape((px, py) => inEllipse(px, py, hx + sx * 2.6, 42.6 - up, 1.6, 1.4), () => L.cloth.mid, L.cloth.line);
	}
}
function paintHuman(g, spec, pose = {}) {
	const L = chooseLook(spec, 18 - (pose.breath === 1 ? 1 : 0));
	const f = L.face;
	if (L.hairStyle === "hijab") {
		paintBody(g, L);
		paintHijab(g, L, f);
		paintHead$1(g, L, f, inOpening(f));
		paintFeatures(g, L, f, pose);
	} else {
		paintHairBack(g, L, f);
		paintBody(g, L);
		paintNeck$1(g, L, f);
		paintHairOverBody(g, L, f);
		paintEars$1(g, L, f);
		paintHead$1(g, L, f);
		paintFeatures(g, L, f, pose);
		paintHairFront(g, L, f);
		if (L.glasses) repaintGlassesOverHair(g, L, f);
	}
	if (pose.typing) paintTyping$1(g, L, pose.typing);
}
/** Glasses temples sit over side hair; re-stamp just the frame fronts so a fringe never hides them. */
function repaintGlassesOverHair(g, L, f) {
	if (!L.glasses) return;
	const lid = Math.round(f.cy) - 1;
	const fr = L.glasses.frame;
	for (const x0 of [13, 21]) {
		for (let y = lid; y <= lid + 3; y++) {
			g.set(x0, y, fr);
			g.set(x0 + 5, y, fr);
		}
		for (let x = x0 + (L.glasses.round ? 1 : 0); x <= x0 + 5 - (L.glasses.round ? 1 : 0); x++) g.set(x, lid + 3, fr);
	}
}
//#endregion
//#region src/engine/agent.ts
var CX = 20;
var FAMILIES = {
	avg: {
		head: "monitor",
		shell: [
			"#4a6082",
			"#3f5677",
			"#56698a"
		],
		body: ["#33435c", "#2e3d55"],
		trim: [
			"#2563eb",
			"#4c6fd1",
			"#7f93b8"
		],
		screen: "#0e1a2e",
		glow: [
			"#9cc0ff",
			"#c4d6ff",
			"#8fb0f0"
		],
		plate: "#e4e9f1",
		antennas: [
			"none",
			"single",
			"side",
			"double",
			"dish"
		],
		eyes: [
			"dots",
			"tall",
			"bars",
			"ring",
			"wide"
		]
	},
	anthropic: {
		head: "squircle",
		shell: [
			"#d97757",
			"#c96a4b",
			"#d4825f"
		],
		body: ["#ece6da", "#e4dccd"],
		trim: [
			"#a85a3f",
			"#8a7f71",
			"#5f564b"
		],
		screen: "#2a201c",
		glow: [
			"#f6ead8",
			"#ffd8b5",
			"#fff3e6"
		],
		plate: "#f8f4ec",
		antennas: [
			"none",
			"none",
			"single",
			"side"
		],
		eyes: [
			"dots",
			"tall",
			"ring",
			"wide"
		]
	},
	aws: {
		head: "box",
		shell: [
			"#232f3e",
			"#2c3b4e",
			"#1c2633"
		],
		body: ["#3a4a5e", "#324154"],
		trim: [
			"#ff9900",
			"#e98b1a",
			"#c9d1db"
		],
		screen: "#090e15",
		glow: [
			"#ffb340",
			"#ffc56b",
			"#ffa424"
		],
		plate: "#e7eaee",
		antennas: [
			"none",
			"side",
			"single",
			"dish"
		],
		eyes: [
			"bars",
			"wide",
			"dots"
		]
	},
	kiro: {
		head: "dome",
		shell: [
			"#f1edff",
			"#e8e1ff",
			"#f7f4ff"
		],
		body: [
			"#7b5cf0",
			"#6a4cdc",
			"#8667f2"
		],
		trim: [
			"#4c33b8",
			"#a593ff",
			"#3d2a94"
		],
		screen: "#1d1442",
		glow: [
			"#d9ccff",
			"#ffffff",
			"#c2b0ff"
		],
		plate: "#f3efff",
		antennas: [
			"none",
			"none",
			"single"
		],
		eyes: [
			"tall",
			"dots",
			"ring"
		]
	},
	aisdlc: {
		head: "hex",
		shell: [
			"#2f6f5e",
			"#2a6455",
			"#3a7d6a"
		],
		body: ["#3e4f4a", "#36463f"],
		trim: [
			"#9cc45a",
			"#7fae4f",
			"#c3d98a"
		],
		screen: "#0b221d",
		glow: [
			"#c0f292",
			"#dcf8b4",
			"#a8e57a"
		],
		plate: "#e3ece6",
		antennas: [
			"double",
			"double",
			"dish"
		],
		eyes: [
			"dots",
			"bars",
			"wide",
			"ring"
		]
	},
	mock: {
		head: "crate",
		shell: [
			"#a9adb4",
			"#9ea3ab",
			"#b3b7be"
		],
		body: ["#7c818a", "#71767f"],
		trim: ["#f59e0b", "#e9a23b"],
		screen: "#25272c",
		glow: ["#f8bd4a", "#ffd27a"],
		plate: "#eceef0",
		antennas: [
			"single",
			"none",
			"side"
		],
		eyes: [
			"dots",
			"bars",
			"ring"
		]
	}
};
var EMBLEMS = {
	magnifier: [
		"..###....",
		".#lll#...",
		"#lllll#..",
		"#lllll#..",
		"#lllll#..",
		".#lll#a..",
		"..###aaa.",
		"......aaa",
		".......a."
	],
	shield: [
		".#######.",
		"#aaaalll#",
		"#aaaalll#",
		"#aaaalll#",
		"#aaaalll#",
		".#aaall#.",
		"..#aal#..",
		"...#a#...",
		"....#...."
	],
	gear: [
		"....a....",
		".a.aaa.a.",
		"..aaaaa..",
		".aaa.aaa.",
		"aaa...aaa",
		".aaa.aaa.",
		"..aaaaa..",
		".a.aaa.a.",
		"....a...."
	],
	check: [
		".........",
		".........",
		".......aa",
		"......aaa",
		"aa...aaa.",
		"aaa.aaa..",
		".aaaaa...",
		"..aaa....",
		"...a....."
	],
	wrench: [
		"......a.a",
		".....aa.a",
		".....aaaa",
		"....aaa..",
		"...aaa...",
		"..aaa....",
		".aaa.....",
		"aaa......",
		".a......."
	],
	rocket: [
		"....a....",
		"...aaa...",
		"...ala...",
		"...aaa...",
		"...aaa...",
		"..aaaaa..",
		".aa.a.aa.",
		"....g....",
		"...g.g..."
	],
	compass: [
		"....#....",
		"...#a#...",
		"...a.a...",
		"..a...a..",
		"..a...a..",
		".a.....a.",
		".a.....a.",
		"a.......#",
		"a........"
	],
	setsquare: [
		"a........",
		"aa.......",
		"a.a......",
		"a..a.....",
		"a...a..#.",
		"a....a.#.",
		"a.....a#.",
		"aaaaaaaa.",
		".......#."
	],
	document: [
		"######...",
		"#llll##..",
		"#l##lll#.",
		"#llllll#.",
		"#l####l#.",
		"#llllll#a",
		"#l###laa.",
		"#lllllaa.",
		"#######.."
	],
	clipboard: [
		"...aaa...",
		".#######.",
		".#lllll#.",
		".#al##l#.",
		".#lllll#.",
		".#al##l#.",
		".#lllll#.",
		".#al##l#.",
		".#######."
	],
	book: [
		".........",
		".##...##.",
		"#ll#.#ll#",
		"#lll#lll#",
		"#lll#lll#",
		"#lll#lll#",
		"#lll#lll#",
		"##aa#aa##",
		"........."
	],
	scissors: [
		"a.......a",
		".a.....a.",
		"..a...a..",
		"...a.a...",
		"....a....",
		"...a.a...",
		".aaa.aaa.",
		"a..a.a..a",
		".aa...aa."
	],
	nodes: [
		"...aaa...",
		"...aaa...",
		"....#....",
		"...#.#...",
		"..#...#..",
		".#.....#.",
		"aaa...aaa",
		"aaa...aaa",
		"........."
	],
	code: [
		".........",
		".....a...",
		"..a..aa..",
		".a..a..a.",
		"a...a...a",
		".a..a..a.",
		"..aa..a..",
		"...a.....",
		"........."
	],
	pulse: [
		".........",
		"...a.....",
		"..aa.....",
		"..a.a....",
		"aa..a..aa",
		"....a.a..",
		".....a...",
		".........",
		"........."
	],
	chip: [
		"..a.a.a..",
		".#######.",
		"a#lllll#a",
		".#l###l#.",
		"a#l#g#l#a",
		".#l###l#.",
		"a#lllll#a",
		".#######.",
		"..a.a.a.."
	]
};
function chooseBot(spec) {
	const family = agentFamily(spec);
	const st = FAMILIES[family];
	const rng = rngFromSeed(`agent-v2:${spec.seed}`);
	const shellC = hex(pick(rng, st.shell));
	const outline = family === "kiro" ? [
		40,
		26,
		92
	] : [
		20,
		18,
		30
	];
	return {
		family,
		st,
		shell: ramp(shellC, outline),
		body: ramp(hex(pick(rng, st.body)), outline),
		trim: ramp(hex(pick(rng, st.trim)), outline),
		screen: hex(st.screen),
		glow: hex(pick(rng, st.glow)),
		plate: ramp(hex(st.plate), [
			30,
			34,
			48
		]),
		antenna: pick(rng, st.antennas),
		eyes: pick(rng, st.eyes),
		mouth: pick(rng, [
			"none",
			"line",
			"grill",
			"smile"
		]),
		cheeks: rng() < .4,
		emblem: emblemFor(spec),
		side: rng() < .5 ? 1 : -1,
		wide: pick(rng, [
			0,
			0,
			1
		])
	};
}
function headGeo(b, oy) {
	const w = b.wide;
	switch (b.st.head) {
		case "monitor": return {
			mask: (px, py) => inRoundRect(px, py, 8 - w, 9 + oy, 32 + w, 29 + oy, 3.5),
			screen: (px, py) => inRoundRect(px, py, 11 - w, 12 + oy, 29 + w, 26 + oy, 2),
			top: 9 + oy,
			eyeY: 17 + oy,
			mouthY: 22 + oy,
			eyeDx: 5
		};
		case "squircle": return {
			mask: (px, py) => inEllipse(px, py, CX, 19.5 + oy, 12.4 + w, 10.4, 3.2),
			screen: (px, py) => inEllipse(px, py, CX, 20 + oy, 9.2 + w, 6.6, 3.4),
			top: 9 + oy,
			eyeY: 18 + oy,
			mouthY: 23 + oy,
			eyeDx: 5
		};
		case "box": {
			const hw = 11.5 + w;
			const hh = 10.5;
			const c = 3.2;
			return {
				mask: (px, py) => {
					const a = Math.abs(px - CX);
					const d = Math.abs(py - (19 + oy));
					return a <= hw && d <= hh && Math.max(0, a - (hw - c)) + Math.max(0, d - 7.3) <= c;
				},
				screen: (px, py) => Math.abs(px - CX) <= hw - 1.6 && py > 15 + oy && py < 22 + oy,
				top: 8.5 + oy,
				eyeY: 18 + oy,
				mouthY: 25 + oy,
				eyeDx: 5
			};
		}
		case "dome": return {
			mask: (px, py) => {
				const a = Math.abs(px - CX);
				if (py < 19.5 + oy) return inEllipse(px, py, CX, 19.5 + oy, 11.6 + w, 11.2);
				return a <= 11.6 + w && py < 28.2 + oy + (Math.floor((px + .5) / 3) % 2 ? 0 : 1);
			},
			screen: (px, py) => inEllipse(px, py, CX, 18.5 + oy, 8 + w, 5.6),
			top: 8.3 + oy,
			eyeY: 17 + oy,
			mouthY: 21 + oy,
			eyeDx: 4
		};
		case "hex": return {
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
			top: 9 + oy,
			eyeY: 18 + oy,
			mouthY: 23 + oy,
			eyeDx: 5
		};
		default: return {
			mask: (px, py) => inRoundRect(px, py, 9 - w, 9 + oy, 31 + w, 29 + oy, 1.6),
			screen: (px, py) => inRoundRect(px, py, 12 - w, 13 + oy, 28 + w, 25 + oy, 1),
			top: 9 + oy,
			eyeY: 17 + oy,
			mouthY: 22 + oy,
			eyeDx: 4
		};
	}
}
function paintChassis(g, b) {
	const body = b.body;
	g.shape((px, py) => inRoundRect(px, py, 3, 34, 37, 52, 4.5), (px, py) => {
		const dx = px - CX;
		if (dx > 12) return body.lo;
		if (dx > 7) return body.mid;
		if (dx < -12 && py < 41) return body.hi;
		return body.base;
	}, body.line);
	for (const sx of [-1, 1]) for (const y of [
		42,
		44,
		46
	]) for (let i = 0; i < 3; i++) g.over(CX + sx * (10 + i) - (sx > 0 ? 0 : 1), y, body.lo);
	const t = b.trim;
	for (const sx of [-1, 1]) {
		const x0 = sx < 0 ? 1.6 : 28.4;
		g.shape((px, py) => inRoundRect(px, py, x0, 32.6, x0 + 10, 40.4, 2.6), (px, py, x, y) => {
			if (b.family === "mock") return (x + y) % 4 < 2 ? hex("#26272b") : t.base;
			if (py < 34.5 && px < CX) return t.hi;
			return px > CX ? t.mid : t.base;
		}, t.line);
	}
	g.set(5, 35, b.glow);
	const p = b.plate;
	g.shape((px, py) => inRoundRect(px, py, 12.6, 35.4, 27.4, 50, 2), (px) => px > 25 ? p.mid : p.base, body.line);
	const ink = mix(b.body.base, [
		10,
		12,
		20
	], .55);
	const accent = b.family === "kiro" ? hex("#5b3fd6") : b.family === "anthropic" ? hex("#b5583a") : b.family === "aws" ? hex("#e57f00") : b.family === "aisdlc" ? hex("#3f7f2f") : b.family === "mock" ? hex("#c27803") : hex("#2563eb");
	g.bitmap(15, 37, EMBLEMS[b.emblem], {
		"#": ink,
		a: accent,
		l: [
			255,
			255,
			255
		],
		g: b.family === "mock" ? hex("#f59e0b") : accent
	});
}
function paintNeck(g, b, oy) {
	const n = ramp(mix(b.body.base, [
		140,
		146,
		160
	], .35));
	g.shape((px, py) => Math.abs(px - CX) <= 3.4 && py > 26 + oy && py < 35.5, (px) => px > 21 ? n.mid : n.base, n.line);
	for (const y of [30, 32]) for (let x = 17; x <= 22; x++) g.over(x, y, n.lo);
}
function paintAntenna(g, b, h) {
	const rod = b.shell.line;
	const top = Math.floor(h.top);
	const ball = (x, y) => {
		g.shape((px, py) => inEllipse(px, py, x + .5, y + .5, 1.6, 1.6), () => b.glow, b.trim.line);
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
			g.shape((px, py) => inEllipse(px, py, x + .5, top - .5, 1.5, 1.5), () => b.trim.base, b.trim.line);
			break;
		}
		case "dish": {
			const x = CX + b.side * 6;
			g.shape((px, py) => inEllipse(px, py, x, top - 1.6, 3.2, 1.4) && py < top - 1, () => b.trim.base, b.trim.line);
			g.set(Math.floor(x), top - 1, rod);
			break;
		}
	}
}
function paintEars(g, b, oy) {
	const t = b.trim;
	const s = b.shell;
	switch (b.st.head) {
		case "monitor":
		case "crate":
			for (const sx of [-1, 1]) {
				const x0 = sx < 0 ? 5.2 - b.wide : 31.2 + b.wide;
				g.shape((px, py) => inRoundRect(px, py, x0, 15 + oy, x0 + 3.6, 23 + oy, 1), (px) => px > CX ? s.mid : s.base, s.line);
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
		case "hex": for (const sx of [-1, 1]) {
			const x0 = sx < 0 ? 5.4 - b.wide : 31.6 + b.wide;
			g.shape((px, py) => inEllipse(px, py, x0 + 1.5, 19.5 + oy, 1.6, 2.4), () => t.base, t.line);
		}
	}
}
function paintHead(g, b, h) {
	const s = b.shell;
	g.shape(h.mask, (px, py) => {
		const dx = px - CX;
		if (!h.mask(px + 1.8, py) || !h.mask(px, py + 1.8)) return s.mid;
		if (dx < -4 && !h.mask(px - 2.2, py) && py < 20) return s.hi;
		if (!h.mask(px, py - 2.2) && dx < 3) return s.hi;
		return s.base;
	}, s.line);
	const bezel = mix(b.screen, b.shell.line, .4);
	g.shape(h.screen, (px, py) => !h.screen(px, py - 1) ? mix(b.screen, [
		255,
		255,
		255
	], .06) : b.screen, bezel, (x, y) => h.mask(x + .5, y + .5));
	if (b.st.head === "box") {
		for (const x of [
			16,
			19,
			22
		]) for (let i = 0; i < 2; i++) g.over(x + i, Math.floor(h.top) + 3, s.lo);
		for (let x = 15; x <= 24; x++) if (x % 2) {
			g.over(x, h.mouthY, s.lo);
			g.over(x, h.mouthY + 2, s.lo);
		}
	} else if (b.st.head === "crate") for (let y = Math.floor(h.top) + 1; y < h.top + 20; y += 2) {
		g.over(10 - b.wide, y, s.mid);
		g.over(29 + b.wide, y, s.mid);
	}
	else if (b.st.head === "monitor") g.over(28 + b.wide, 27 + (h.top - 9), b.glow);
}
function paintFace(g, b, h, pose) {
	const glow = b.glow;
	const soft = mix(b.glow, b.screen, .55);
	const expr = pose.expression ?? "neutral";
	const lookDy = pose.look === "down" ? 1 : pose.look === "up" ? -1 : 0;
	const ey = h.eyeY + lookDy;
	const on = (x, y, c) => {
		if (h.screen(x + .5, y + .5)) g.set(x, y, c);
	};
	for (const side of [-1, 1]) {
		const ex = side < 0 ? CX - h.eyeDx - 1 : CX + h.eyeDx - 1;
		if (b.st.head === "box") {
			const w = pose.blink ? 2 : 4;
			const x0 = side < 0 ? 12 : 24;
			if (pose.blink || expr !== "neutral" || b.eyes === "bars") {
				for (let i = 0; i < w; i++) on(x0 + i + (4 - w) / 2, ey, glow);
				if (!pose.blink && expr !== "happy") for (let i = 0; i < 4; i++) on(x0 + i, ey + 1, soft);
			} else if (b.eyes === "dots") {
				for (const [dx, dy] of [
					[1, 0],
					[2, 0],
					[1, 1],
					[2, 1]
				]) on(x0 + dx, ey + dy, glow);
				on(x0 + (side < 0 ? 1 : 2), ey, [
					255,
					255,
					255
				]);
			} else {
				for (let x = 11; x <= 28; x++) on(x, ey + 1, soft);
				for (let i = 0; i < 4; i++) on(x0 + i, ey + 1, glow);
				on(x0 + 1, ey, soft);
				on(x0 + 2, ey, soft);
			}
			if (expr === "happy") {
				on(x0, ey + 1, glow);
				on(x0 + 3, ey + 1, glow);
			}
			if (expr === "worried") {
				on(side < 0 ? x0 + 3 : x0, ey - 2, soft);
				on(side < 0 ? x0 + 2 : x0 + 1, ey - 2, soft);
			}
			continue;
		}
		if (pose.blink) {
			for (let i = -1; i < 3; i++) on(ex + i, ey + 1, soft);
			continue;
		}
		if (expr === "happy") {
			on(ex - 1, ey + 1, glow);
			on(ex, ey, glow);
			on(ex + 1, ey, glow);
			on(ex + 2, ey + 1, glow);
			continue;
		}
		switch (b.eyes) {
			case "dots":
				on(ex, ey, glow);
				on(ex + 1, ey, glow);
				on(ex, ey + 1, glow);
				on(ex + 1, ey + 1, glow);
				on(ex + (side < 0 ? 0 : 1), ey, [
					255,
					255,
					255
				]);
				break;
			case "tall":
				for (let y = ey - 1; y <= ey + 1; y++) {
					on(ex, y, glow);
					on(ex + 1, y, glow);
				}
				on(ex, ey - 1, [
					255,
					255,
					255
				]);
				break;
			case "bars":
				for (let i = -1; i < 3; i++) on(ex + i, ey + 1, glow);
				on(ex - 1, ey + 1, soft);
				on(ex + 2, ey + 1, soft);
				break;
			case "ring":
				for (const [dx, dy] of [
					[0, -1],
					[1, -1],
					[-1, 0],
					[2, 0],
					[-1, 1],
					[2, 1],
					[0, 2],
					[1, 2]
				]) on(ex + dx, ey + dy, glow);
				break;
			case "wide": for (let i = -1; i < 3; i++) {
				on(ex + i, ey, glow);
				on(ex + i, ey + 1, soft);
			}
		}
		if (expr === "worried") {
			on(side < 0 ? ex + 1 : ex, ey - 2 - (b.eyes === "tall" || b.eyes === "ring" ? 1 : 0), soft);
			on(side < 0 ? ex : ex + 1, ey - 1 - (b.eyes === "tall" || b.eyes === "ring" ? 1 : 0), soft);
		}
	}
	const my = h.mouthY + (b.st.head === "box" ? -5 : 0);
	if (b.st.head === "box") {
		if (pose.mouth === "open") {
			for (let x = 17; x <= 22; x++) if (x % 2) g.over(x, h.mouthY + 1, glow);
		}
		return;
	}
	if (pose.mouth === "open") {
		for (let x = 18; x <= 21; x++) {
			on(x, my, glow);
			on(x, my + 1, soft);
		}
		return;
	}
	if (expr === "happy") {
		on(17, my - 1, glow);
		on(22, my - 1, glow);
		for (let x = 18; x <= 21; x++) on(x, my, glow);
		return;
	}
	if (expr === "worried") {
		on(17, my + 1, soft);
		on(18, my, soft);
		on(19, my, soft);
		on(CX, my, soft);
		on(21, my, soft);
		on(22, my + 1, soft);
		return;
	}
	switch (b.mouth) {
		case "line":
			for (let x = 18; x <= 21; x++) on(x, my, soft);
			break;
		case "grill":
			for (const x of [
				17,
				19,
				21
			]) on(x, my, soft);
			break;
		case "smile":
			on(18, my - 1, soft);
			on(21, my - 1, soft);
			on(19, my, soft);
			on(CX, my, soft);
	}
	if (b.cheeks) {
		on(CX - h.eyeDx - 3, my - 1, mix(glow, b.screen, .7));
		on(CX + h.eyeDx + 2, my - 1, mix(glow, b.screen, .7));
	}
}
function paintTyping(g, b, frame) {
	const kb = ramp(hex("#d5dae1"), [
		40,
		46,
		60
	]);
	g.shape((px, py) => px > 8 && px < 32 && py > 44.4, (_px, py, x) => py < 45.5 ? kb.hi : x % 3 === 0 ? kb.mid : kb.base, kb.line);
	const t = b.trim;
	for (const sx of [-1, 1]) {
		const up = sx < 0 && frame === 1 || sx > 0 && frame === 2 ? 1 : 0;
		const hx = CX + sx * 6.5;
		g.shape((px, py) => inRoundRect(px, py, hx - 2.2, 42.6 - up, hx + 2.2, 45.4 - up, 1), (px) => (px - hx) * sx > .6 ? t.mid : t.base, t.line);
	}
}
function paintAgent(g, spec, pose = {}) {
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
//#endregion
//#region src/engine/portrait.ts
function portraitPixels(spec, pose = {}) {
	const g = new PixelGrid(40, 48);
	if (spec.style === "agent") paintAgent(g, spec, pose);
	else if (spec.style === "human") paintHuman(g, spec, pose);
	return g;
}
function portraitHash(spec, pose = {}) {
	return gridHash(portraitPixels(spec, pose));
}
//#endregion
//#region src/engine/avatarStyles.ts
var ACCENT = "#2563eb";
var PASS = "#00BCD4";
var FAIL = "#E91E63";
/** Paints the PORTRAIT_W × PORTRAIT_H grid of a human or agent into a 2D context at (0, 0). */
function paintPortrait(ctx, spec, pose) {
	const g = portraitPixels(spec, pose);
	ctx.clearRect(0, 0, 40, 48);
	ctx.putImageData(new ImageData(new Uint8ClampedArray(g.data), 40, 48), 0, 0);
}
var portraitCache = /* @__PURE__ */ new Map();
function specKey(spec) {
	return [
		spec.style,
		spec.seed,
		spec.role ?? "",
		spec.badge ?? "",
		spec.family ?? ""
	].join("|");
}
/** The unscaled portrait grid for a human/agent spec in a pose (cached). */
function portraitGrid(spec, pose) {
	const key = `${specKey(spec)}|${poseKey(pose)}`;
	const hit = portraitCache.get(key);
	if (hit) return hit;
	const c = document.createElement("canvas");
	c.width = 40;
	c.height = 48;
	const ctx = c.getContext("2d");
	if (ctx) paintPortrait(ctx, spec, pose);
	if (portraitCache.size > 2e3) portraitCache.clear();
	portraitCache.set(key, c);
	return c;
}
/**
* Largest crisp size for a portrait that should be about `target` px wide: a whole number of device pixels per
* grid pixel, so nearest-neighbour scaling never doubles some columns and not others. Falls back to `target`.
*/
function crispWidth(target, deviceScale) {
	const k = Math.floor(target * deviceScale / 40 + 1e-6);
	return k >= 1 ? k * 40 / deviceScale : target;
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
	bodyShade: "#aeb6c2",
	idle: "#c4cad3"
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
		rect(ctx, x - 6 * s, baseY - 6 * s, w + 12 * s, 6 * s, p.bodyShade);
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
		rect(ctx, x + 6 * s, y + h, 6 * s, 14 * s, p.bodyShade);
		rect(ctx, x + w - 12 * s, y + h, 6 * s, 14 * s, p.bodyShade);
		rect(ctx, x, y, w, h, p.body, state.active ? ACCENT : p.lineStrong, 1.5);
		const slot = w / lights.length;
		lights.forEach((l, i) => {
			const mx = x + i * slot + slot * .18;
			const mw = slot * .64;
			rect(ctx, mx, y - 24 * s, mw, 20 * s, p.surface, p.lineStrong, 1);
			rect(ctx, mx + 3 * s, y - 21 * s, mw - 6 * s, 14 * s, lightColor(l, p));
			rect(ctx, mx + mw / 2 - 2 * s, y - 4 * s, 4 * s, 4 * s, p.bodyShade);
		});
		top = y - 24 * s;
	} else if (kind === "board") {
		const w = 96 * s;
		const h = 62 * s;
		const x = cx - w / 2;
		const y = baseY - h - 18 * s;
		rect(ctx, x + 10 * s, y + h, 5 * s, 18 * s, p.bodyShade);
		rect(ctx, x + w - 15 * s, y + h, 5 * s, 18 * s, p.bodyShade);
		rect(ctx, x, y, w, h, p.surface, state.active ? ACCENT : p.lineStrong, state.active ? 2 : 1.5);
		for (let i = 0; i < 4; i++) {
			const ry = y + 9 * s + i * 13 * s;
			rect(ctx, x + 8 * s, ry, 8 * s, 8 * s, i === 0 && state.active ? ACCENT : p.idle);
			rect(ctx, x + 22 * s, ry + 2 * s, (w - 34 * s) * (i % 2 ? .7 : .9), 4 * s, p.lineStrong);
		}
		top = y;
	} else {
		const w = 64 * s;
		const h = 58 * s;
		const x = cx - w / 2;
		const y = baseY - h;
		rect(ctx, x + 6 * s, baseY - 4 * s, w - 12 * s, 4 * s, p.bodyShade);
		rect(ctx, x, y, w, h - 4 * s, p.body, state.active ? ACCENT : p.lineStrong, 1.5);
		rect(ctx, x + 8 * s, y + 8 * s, w - 16 * s, 18 * s, p.surface, p.lineStrong, 1);
		for (let i = 0; i < 3; i++) rect(ctx, x + 13 * s, y + 12 * s + i * 4.5 * s, (w - 26 * s) * (i === 1 ? .6 : .85), 2 * s, p.lineStrong);
		rect(ctx, x + 8 * s, y + 33 * s, 8 * s, 8 * s, state.active ? ACCENT : p.idle);
		rect(ctx, x + 22 * s, y + 36 * s, w - 30 * s, 3 * s, p.bodyShade);
		top = y;
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
* Renders a complete avatar card image (portrait, or system object) into `canvas`, about `size` px wide.
* Portraits are drawn at the largest crisp size that fits and centred; agents get their badge under the bust.
* Used by the Teams gallery and the theater's map; the theater floor draws the same grids and objects on its stage.
*/
function renderAvatar(canvas, spec, size = 96, palette = LIGHT) {
	const dpr = typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 3) : 1;
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	if (spec.style === "system") {
		const h = Math.round(size * 48 / 40);
		sizeCanvas(canvas, size, h, dpr);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, size, h);
		const kind = systemKind(spec);
		const s = size / 140;
		drawSystemObject(ctx, kind, size / 2, h - 6 * s, kind === "tower" ? s * .9 : s, { active: false }, palette);
		return;
	}
	const w = crispWidth(size, dpr);
	const ph = w * 48 / 40;
	const gridPx = w / 40;
	const s = Math.max(w, 40) / 96;
	const badgeH = Math.max(13, 15 * s);
	const badgeY = ph - 2 * gridPx;
	const h = Math.ceil(spec.style === "agent" ? badgeY + badgeH : ph);
	sizeCanvas(canvas, size, h, dpr);
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, size, h);
	ctx.imageSmoothingEnabled = false;
	const x = Math.round((size - w) / 2 * dpr) / dpr;
	ctx.drawImage(portraitGrid(spec), x, 0, w, ph);
	if (spec.style === "agent") drawBadge(ctx, size / 2, badgeY, spec.badge, s);
}
function sizeCanvas(canvas, w, h, dpr) {
	canvas.width = Math.round(w * dpr);
	canvas.height = Math.round(h * dpr);
	canvas.style.width = `${w}px`;
	canvas.style.height = `${h}px`;
}
//#endregion
export { ACCENT, FAIL, LIGHT, PASS, PORTRAIT_H, PORTRAIT_W, agentFamily, crispWidth, drawBadge, drawSystemObject, emblemFor, humanGroup, paintPortrait, portraitGrid, portraitHash, portraitPixels, poseKey, renderAvatar, systemKind };
