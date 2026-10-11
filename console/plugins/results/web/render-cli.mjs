// Server-side SVG export (api.py → GET /api/results/export): reads {spec, style, fontCss} as JSON on stdin and prints
// the 1920×1080 slide as SVG on stdout. It is the same drawing code as the browser (charts.js), so the file the server
// returns and the file the page downloads are identical.
import { renderSlide } from "./charts.js";

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const job = JSON.parse(Buffer.concat(chunks).toString("utf8"));
process.stdout.write(renderSlide(job.spec, { style: job.style === "deck" ? "deck" : "app", fontCss: job.fontCss || "" }));
