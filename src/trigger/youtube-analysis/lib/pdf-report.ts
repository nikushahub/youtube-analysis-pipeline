import fs from "node:fs";
import path from "node:path";
import * as fontkit from "fontkit";
import PDFDocument from "pdfkit";
import type { AnalysisSource, VideoReport } from "./types.js";

/**
 * Renders the AIVA+ branded PDF deck (landscape 16:9) for one analyzed video.
 * Visual rules live in ../aiva-design-philosophy.md ("Luminous Signal").
 */

// Shipped next to the bundle by the additionalFiles extension in trigger.config.ts.
const ASSETS = path.join(process.cwd(), "src/trigger/youtube-analysis/assets");

const W = 960;
const H = 540;
const M = 56; // outer margin, identical on every page
const RAIL_W = 220; // left rail: index numeral, section title
const CONTENT_X = M + RAIL_W + 40;
const CONTENT_W = W - M - CONTENT_X;
const CONTENT_TOP = 112;
const CONTENT_BOTTOM = 462;
const ITEMS_PER_PAGE = 8;

const C = {
  bg: "#1E2327", // sampled from the logo's own background so the logo blends in seamlessly
  ink: "#EEF1F4",
  body: "#C9D0D7",
  muted: "#8B95A0",
  faint: "#5E6873",
  silver: "#B8C0C8",
  cobalt: "#1B5B9B",
  blue: "#1873BC",
  cyan: "#4EB0D7",
};

const FONT_FILES = {
  thin: "Outfit-ExtraLight.ttf",
  light: "Outfit-Light.ttf",
  display: "Outfit-Regular.ttf",
  strong: "Outfit-SemiBold.ttf",
  body: "WorkSans-Regular.ttf",
  mono: "GeistMono-Regular.ttf",
  fallbackLatin: "NotoSans-Regular.ttf", // Latin, Cyrillic, Greek
  fallbackGeorgian: "NotoSansGeorgian-Regular.ttf",
} as const;
type FontKey = keyof typeof FONT_FILES;
const FALLBACKS: FontKey[] = ["fallbackLatin", "fallbackGeorgian"];

// Transparent cut-outs of aiva_plus_logo.jpg (the brand master), each with a soft margin around the artwork.
const LOGOS = {
  full: { file: "aiva_plus_logo.png", aspect: 568 / 444 }, // emblem + AIVA+ + tagline
  emblem: { file: "aiva_plus_emblem.png", aspect: 406 / 258 }, // emblem only, for page headers
};
type LogoKey = keyof typeof LOGOS;

interface Assets {
  fonts: Record<FontKey, Buffer>;
  coverage: Record<FontKey, fontkit.Font>;
  logos: Record<LogoKey, Buffer>;
}

let cachedAssets: Assets | null = null;
function loadAssets(): Assets {
  if (cachedAssets) return cachedAssets;
  const fonts = {} as Record<FontKey, Buffer>;
  const coverage = {} as Record<FontKey, fontkit.Font>;
  for (const [key, file] of Object.entries(FONT_FILES) as [FontKey, string][]) {
    fonts[key] = fs.readFileSync(path.join(ASSETS, "fonts", file));
    coverage[key] = fontkit.create(fonts[key]) as fontkit.Font;
  }
  const logos = {} as Record<LogoKey, Buffer>;
  for (const [key, { file }] of Object.entries(LOGOS) as [LogoKey, { file: string }][]) {
    logos[key] = fs.readFileSync(path.join(ASSETS, file));
  }
  cachedAssets = { fonts, coverage, logos };
  return cachedAssets;
}

type Doc = PDFKit.PDFDocument;

// pdfkit re-embeds a Buffer image on every use; opening it once per document embeds it once.
// (doc.openImage exists at runtime but is missing from @types/pdfkit.)
type OpenedImage = Parameters<Doc["image"]>[0];
type DocWithOpenImage = Doc & { openImage(src: Buffer): OpenedImage };
const openedLogos = new WeakMap<Doc, Partial<Record<LogoKey, OpenedImage>>>();

// ---------------------------------------------------------------------------------------------
// Text: per-character font fallback so titles in any script (or with emoji) never render as boxes
// ---------------------------------------------------------------------------------------------

interface Run {
  font: FontKey;
  text: string;
}

function toRuns(text: string, preferred: FontKey): Run[] {
  const { coverage } = loadAssets();
  const chain = [preferred, ...FALLBACKS];
  const runs: Run[] = [];
  for (const ch of text.replace(/[ \t]+/g, " ")) {
    const last = runs[runs.length - 1];
    if (/\s/.test(ch)) {
      if (last) last.text += ch;
      else runs.push({ font: preferred, text: ch });
      continue;
    }
    const font = chain.find((f) => coverage[f].hasGlyphForCodePoint(ch.codePointAt(0)!));
    if (!font) continue; // emoji and symbols no bundled font has: drop rather than draw a box
    if (last && last.font === font) last.text += ch;
    else runs.push({ font, text: ch });
  }
  // Collapse the double spaces (and leading/trailing ones) left behind by dropped characters.
  const cleaned = runs.map((r) => ({ ...r, text: r.text.replace(/ {2,}/g, " ") }));
  if (cleaned.length) {
    cleaned[0].text = cleaned[0].text.trimStart();
    cleaned[cleaned.length - 1].text = cleaned[cleaned.length - 1].text.trimEnd();
  }
  return cleaned.filter((r) => r.text.length);
}

interface TextStyle {
  font: FontKey;
  size: number;
  color: string;
  opacity?: number;
  width?: number;
  height?: number;
  lineGap?: number;
  spacing?: number; // character spacing (tracking), in points
  align?: "left" | "right" | "center";
  link?: string;
  oneLine?: boolean;
}

function measure(doc: Doc, text: string, s: TextStyle): number {
  const runs = toRuns(text, s.font);
  const joined = runs.map((r) => r.text).join("");
  // Mixed scripts: approximate with the broad fallback font and leave a safety margin.
  const font = runs.length === 1 ? runs[0].font : "fallbackLatin";
  const factor = runs.length === 1 ? 1 : 1.08;
  doc.font(font).fontSize(s.size);
  return (
    doc.heightOfString(joined, { width: s.width, lineGap: s.lineGap ?? 0, characterSpacing: s.spacing ?? 0 }) * factor
  );
}

function textWidth(doc: Doc, text: string, s: TextStyle): number {
  return toRuns(text, s.font).reduce((sum, r) => {
    doc.font(r.font).fontSize(s.size);
    return sum + doc.widthOfString(r.text, { characterSpacing: s.spacing ?? 0 });
  }, 0);
}

function drawText(doc: Doc, text: string, x: number, y: number, s: TextStyle): void {
  const runs = toRuns(text, s.font);
  if (!runs.length) return;
  doc.fillColor(s.color, s.opacity ?? 1);
  runs.forEach((run, i) => {
    doc.font(run.font).fontSize(s.size);
    const options: PDFKit.Mixins.TextOptions = {
      width: s.width,
      lineGap: s.lineGap ?? 0,
      characterSpacing: s.spacing ?? 0,
      align: s.align ?? "left",
      link: s.link,
      lineBreak: !s.oneLine,
      continued: i < runs.length - 1,
      // Height + ellipsis guarantee nothing ever spills past its box (single-font text only;
      // pdfkit can't combine them with font switching mid-paragraph).
      ...(runs.length === 1 && s.height ? { height: s.height, ellipsis: true } : {}),
    };
    if (i === 0) doc.text(run.text, x, y, options);
    else doc.text(run.text, options);
  });
  doc.fillOpacity(1);
}

/** Largest font size (stepping down by 0.5pt) at which every text fits its box. */
function fitSize(doc: Doc, texts: string[], style: Omit<TextStyle, "size">, max: number, min: number, gapRatio: number) {
  for (let size = max; size > min; size -= 0.5) {
    const fits = texts.every((t) => measure(doc, t, { ...style, size, lineGap: size * gapRatio }) <= style.height!);
    if (fits) return size;
  }
  return min;
}

/** Shortens a string to fit one line of the given width. */
function clampLine(doc: Doc, text: string, s: TextStyle, maxWidth: number): string {
  if (textWidth(doc, text, s) <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidth(doc, text.slice(0, mid).trimEnd() + "…", s) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd() + "…";
}

// ---------------------------------------------------------------------------------------------
// Brand marks
// ---------------------------------------------------------------------------------------------

/** Places a logo cut-out centred on (cx, cy) at the given height. */
function drawLogo(doc: Doc, variant: LogoKey, cx: number, cy: number, height: number): void {
  const opened = openedLogos.get(doc) ?? {};
  openedLogos.set(doc, opened);
  const image = (opened[variant] ??= (doc as DocWithOpenImage).openImage(loadAssets().logos[variant]));
  const width = height * LOGOS[variant].aspect;
  doc.image(image, cx - width / 2, cy - height / 2, { width, height });
}

/** A faint cobalt bloom: light gathering behind a mark. */
function glow(doc: Doc, cx: number, cy: number, radius: number, opacity: number): void {
  const bloom = doc.radialGradient(cx, cy, 0, cx, cy, radius);
  bloom.stop(0, C.blue, opacity).stop(0.55, C.cobalt, opacity * 0.35).stop(1, C.cobalt, 0);
  doc.circle(cx, cy, radius).fill(bloom);
}

/** The logo's nested forward chevron, reduced to two hairlines. */
function chevron(doc: Doc, x: number, cy: number, size: number): void {
  const draw = (dx: number, color: string, opacity: number) => {
    doc
      .moveTo(x + dx, cy - size)
      .lineTo(x + dx + size * 0.75, cy)
      .lineTo(x + dx, cy + size)
      .lineWidth(0.75)
      .lineJoin("miter")
      .strokeColor(color, opacity)
      .stroke();
  };
  draw(0, C.silver, 0.55);
  draw(size * 0.55, C.cyan, 1);
  doc.strokeOpacity(1);
}

/** A short cobalt → cyan rule: the one place per element where colour is allowed to appear. */
function signalRule(doc: Doc, x: number, y: number, width: number, weight = 1.25): void {
  const grad = doc.linearGradient(x, y, x + width, y);
  grad.stop(0, C.cobalt, 1).stop(0.6, C.cyan, 1).stop(1, C.cyan, 0);
  doc.rect(x, y, width, weight).fill(grad);
}

function hairline(doc: Doc, x1: number, y1: number, x2: number, y2: number, opacity = 0.16): void {
  doc.moveTo(x1, y1).lineTo(x2, y2).lineWidth(0.4).strokeColor(C.silver, opacity).stroke();
  doc.strokeOpacity(1);
}

/** Deterministic PRNG so a given video always gets the same constellation. */
function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

/**
 * The logo's node network, rendered as a faint star chart. Nodes thin out away from the anchor
 * corner, so the pattern dissolves into the page instead of ending at a box edge.
 */
function constellation(
  doc: Doc,
  seed: string,
  area: { x: number; y: number; w: number; h: number },
  anchor: { x: number; y: number },
  count: number
): void {
  const rand = seededRandom(seed);
  const reach = Math.hypot(area.w, area.h);
  const nodes: { x: number; y: number; weight: number }[] = [];
  for (let tries = 0; nodes.length < count && tries < count * 60; tries++) {
    const x = area.x + rand() * area.w;
    const y = area.y + rand() * area.h;
    const weight = 1 - Math.hypot(x - anchor.x, y - anchor.y) / reach;
    if (rand() > weight * 1.15) continue; // denser near the anchor
    if (nodes.some((n) => Math.hypot(n.x - x, n.y - y) < 16)) continue;
    nodes.push({ x, y, weight: Math.max(weight, 0.15) });
  }

  const edges = new Set<string>();
  nodes.forEach((n, i) => {
    nodes
      .map((m, j) => ({ j, d: Math.hypot(m.x - n.x, m.y - n.y) }))
      .filter((e) => e.j !== i && e.d < 70)
      .sort((p, q) => p.d - q.d)
      .slice(0, 2)
      .forEach(({ j }) => edges.add(i < j ? `${i}-${j}` : `${j}-${i}`));
  });

  for (const key of edges) {
    const [i, j] = key.split("-").map(Number);
    const opacity = 0.2 * Math.min(nodes[i].weight, nodes[j].weight);
    doc.moveTo(nodes[i].x, nodes[i].y).lineTo(nodes[j].x, nodes[j].y);
    doc.lineWidth(0.35).strokeColor(C.silver, opacity).stroke();
  }
  nodes.forEach((n, i) => {
    const lit = i % 7 === 0;
    if (lit) doc.circle(n.x, n.y, 5).fillColor(C.cyan, 0.08 * n.weight).fill();
    doc
      .circle(n.x, n.y, lit ? 1.6 : 0.6 + n.weight * 0.9)
      .fillColor(lit ? C.cyan : C.silver, (lit ? 0.85 : 0.45) * n.weight)
      .fill();
  });
  doc.fillOpacity(1).strokeOpacity(1);
}

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------

const SOURCE_LABEL: Record<AnalysisSource, { value: string; note: string }> = {
  transcript: { value: "Full transcript", note: "Every spoken word was analyzed." },
  video: { value: "Watched the video", note: "No transcript, so the AI watched the video directly." },
  metadata: { value: "Title & description", note: "No transcript or video access. Treat as a brief overview." },
};

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

function formatCompact(n: number | null): string {
  return n === null ? "—" : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

// ---------------------------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------------------------

interface PageContext {
  doc: Doc;
  report: VideoReport;
  pageNumber: number;
  totalPages: number;
}

const LABEL: Omit<TextStyle, "color"> = { font: "mono", size: 7, spacing: 1.6, oneLine: true };

function newPage(doc: Doc): void {
  doc.addPage({ size: [W, H], margin: 0 });
  doc.rect(0, 0, W, H).fill(C.bg);
}

function pageChrome(ctx: PageContext): void {
  const { doc } = ctx;
  drawLogo(doc, "emblem", M + 17, 50.5, 23);
  drawText(doc, "AIVA+", M + 46, 47, { ...LABEL, color: C.ink, spacing: 2 });
  drawText(doc, "VIDEO INTELLIGENCE REPORT", M + 88, 47, { ...LABEL, color: C.muted });

  const pager = `${pad2(ctx.pageNumber)} / ${pad2(ctx.totalPages)}`;
  const pagerW = textWidth(doc, pager, { ...LABEL, color: C.muted });
  drawText(doc, pager, W - M - pagerW, 47, { ...LABEL, color: C.silver });
  chevron(doc, W - M - pagerW - 22, 50.5, 3.6);

  footer(ctx);
}

function footer(ctx: PageContext): void {
  const { doc, report } = ctx;
  const y = H - 48;
  hairline(doc, M, y, W - M, y);
  const right = `AIVA+  ·  ${formatDate(report.analyzedAt).toUpperCase()}`;
  const rightW = textWidth(doc, right, { ...LABEL, color: C.faint });
  drawText(doc, right, W - M - rightW, y + 12, { ...LABEL, color: C.faint });
  // Only Latin titles are set in capitals; uppercasing other scripts (e.g. Georgian) changes their letterforms.
  const raw = report.metadata.title;
  const titleText = /^[\u0000-ɏ\s\p{Emoji}]*$/u.test(raw) ? raw.toUpperCase() : raw;
  const title = clampLine(doc, titleText, { ...LABEL, color: C.faint }, W - 2 * M - rightW - 40);
  drawText(doc, title, M, y + 12, { ...LABEL, color: C.faint });
}

/** Left rail shared by every content page: big thin index numeral, kicker, section title. */
function rail(ctx: PageContext, index: number, kicker: string, title: string): number {
  const { doc } = ctx;
  const numeral = pad2(index);
  const grad = doc.linearGradient(M, CONTENT_TOP, M + 110, CONTENT_TOP + 80);
  grad.stop(0, C.cyan, 1).stop(1, C.cobalt, 1);
  doc.font("thin").fontSize(84).fillColor(grad);
  doc.text(numeral, M - 5, CONTENT_TOP - 14, { lineBreak: false });

  chevron(doc, M, CONTENT_TOP + 104, 3.4);
  drawText(doc, kicker, M + 16, CONTENT_TOP + 101, { ...LABEL, color: C.cyan, spacing: 2 });
  const titleStyle: TextStyle = { font: "light", size: 30, color: C.ink, width: RAIL_W, lineGap: 2 };
  drawText(doc, title, M, CONTENT_TOP + 120, titleStyle);
  return CONTENT_TOP + 120 + measure(doc, title, titleStyle);
}

function railConstellation(ctx: PageContext): void {
  constellation(
    ctx.doc,
    `${ctx.report.metadata.videoId}:${ctx.pageNumber}`,
    { x: M, y: 330, w: RAIL_W - 10, h: CONTENT_BOTTOM - 330 },
    { x: M, y: CONTENT_BOTTOM },
    26
  );
}

function coverPage(ctx: PageContext): void {
  const { doc, report } = ctx;
  const m = report.metadata;

  glow(doc, 272, 236, 230, 0.16);
  drawLogo(doc, "full", 272, 262, 250);

  // Vertical signal line separating the brand from the briefing.
  const lineX = 540;
  const vGrad = doc.linearGradient(lineX, 96, lineX, 444);
  vGrad.stop(0, C.cyan, 0).stop(0.5, C.cyan, 0.55).stop(1, C.cyan, 0);
  doc.rect(lineX, 96, 0.6, 348).fill(vGrad);

  const x = 584;
  const width = W - M - x;
  chevron(doc, x, 99.5, 3.4);
  drawText(doc, "VIDEO INTELLIGENCE REPORT", x + 16, 96, { ...LABEL, color: C.cyan, spacing: 2.2 });

  const titleStyle = { font: "light" as const, color: C.ink, width, height: 150 };
  const size = fitSize(doc, [m.title], titleStyle, 34, 17, 0.12);
  const tStyle: TextStyle = { ...titleStyle, size, lineGap: size * 0.12 };
  drawText(doc, m.title, x, 124, tStyle);
  const titleBottom = 124 + Math.min(measure(doc, m.title, tStyle), 150);

  drawText(doc, m.channelTitle, x, titleBottom + 14, {
    font: "body",
    size: 11.5,
    color: C.muted,
    width,
    height: 16,
    oneLine: true,
  });
  signalRule(doc, x, titleBottom + 44, 56);

  const facts: [string, string][] = [
    ["PUBLISHED", formatDate(m.publishedAt)],
    ["DURATION", m.duration || "—"],
    ["ANALYZED", formatDate(report.analyzedAt)],
    ["SOURCE", SOURCE_LABEL[report.analysisSource].value],
  ];
  const colW = width / 2;
  facts.forEach(([label, value], i) => {
    const fx = x + (i % 2) * colW;
    const fy = 352 + Math.floor(i / 2) * 50;
    hairline(doc, fx, fy, fx + colW - 18, fy, 0.14);
    drawText(doc, label, fx, fy + 10, { ...LABEL, size: 6.5, color: C.faint });
    drawText(doc, value, fx, fy + 22, { font: "display", size: 12.5, color: C.ink, width: colW - 18, oneLine: true });
  });

  footer(ctx);
}

function summaryPage(ctx: PageContext, index: number): void {
  const { doc, report } = ctx;
  pageChrome(ctx);
  const railBottom = rail(ctx, index, "THE VIDEO IN BRIEF", "Summary");

  const source = SOURCE_LABEL[report.analysisSource];
  const sy = Math.max(railBottom + 28, 300);
  drawText(doc, "ANALYZED FROM", M, sy, { ...LABEL, size: 6.5, color: C.faint });
  drawText(doc, source.value, M, sy + 13, { font: "display", size: 12, color: C.ink, width: RAIL_W, oneLine: true });
  drawText(doc, source.note, M, sy + 32, {
    font: "body",
    size: 8.5,
    color: C.muted,
    width: RAIL_W - 30,
    height: 40,
    lineGap: 2,
  });

  // Editorial split: the first sentence becomes the lead, the rest is body copy.
  const summary = report.analysis.summary.trim();
  const match = summary.match(/^(.{20,}?[.!?])\s+([\s\S]+)$/);
  const lead = match ? match[1] : summary;
  const rest = match ? match[2] : "";

  const leadBox = { font: "light" as const, color: C.ink, width: CONTENT_W, height: 130 };
  const leadSize = fitSize(doc, [lead], leadBox, 24, 15, 0.22);
  const leadStyle: TextStyle = { ...leadBox, size: leadSize, lineGap: leadSize * 0.22 };
  drawText(doc, lead, CONTENT_X, CONTENT_TOP, leadStyle);
  if (!rest) return;

  const leadBottom = CONTENT_TOP + Math.min(measure(doc, lead, leadStyle), 130);
  signalRule(doc, CONTENT_X, leadBottom + 22, 40);
  const bodyTop = leadBottom + 46;
  const bodyBox = { font: "body" as const, color: C.body, width: CONTENT_W, height: CONTENT_BOTTOM - bodyTop };
  const bodySize = fitSize(doc, [rest], bodyBox, 13.5, 9.5, 0.55);
  drawText(doc, rest, CONTENT_X, bodyTop, { ...bodyBox, size: bodySize, lineGap: bodySize * 0.55 });
}

/** Numbered or checkbox items in columns, read top-to-bottom then left-to-right like a newspaper. */
function itemsPage(
  ctx: PageContext,
  index: number,
  kicker: string,
  title: string,
  items: string[],
  firstNumber: number,
  marker: "number" | "check"
): void {
  const { doc } = ctx;
  pageChrome(ctx);
  rail(ctx, index, kicker, title);
  railConstellation(ctx);

  const cols = items.length <= 5 ? 1 : 2;
  const rows = Math.ceil(items.length / cols);
  const colGap = 32;
  const cellW = (CONTENT_W - colGap * (cols - 1)) / cols;
  const cellH = Math.min((CONTENT_BOTTOM - CONTENT_TOP + 8) / rows, 112);
  const textX = 32;
  const textBox = { font: "body" as const, color: C.body, width: cellW - textX, height: cellH - 30 };
  const size = fitSize(doc, items, textBox, 13, 8.5, 0.5);

  items.forEach((item, i) => {
    const col = Math.floor(i / rows);
    const row = i % rows;
    const x = CONTENT_X + col * (cellW + colGap);
    const y = CONTENT_TOP - 8 + row * cellH;
    hairline(doc, x, y, x + cellW, y, row === 0 ? 0.3 : 0.14);

    if (marker === "number") {
      drawText(doc, pad2(firstNumber + i), x, y + 15, { ...LABEL, size: 8, color: C.cyan, spacing: 1 });
    } else {
      doc.rect(x + 0.5, y + 14.5, 9, 9).lineWidth(0.7).strokeColor(C.silver, 0.6).stroke();
      doc.strokeOpacity(1);
    }
    drawText(doc, item, x + textX, y + 13, { ...textBox, size, lineGap: size * 0.5 });
  });
}

function glancePage(ctx: PageContext, index: number): void {
  const { doc, report } = ctx;
  const m = report.metadata;
  pageChrome(ctx);
  rail(ctx, index, "TOPICS & NUMBERS", "At a glance");
  railConstellation(ctx);

  // Stats strip
  const stats: [string, string][] = [
    ["VIEWS", formatCompact(m.viewCount)],
    ["LIKES", formatCompact(m.likeCount)],
    ["DURATION", m.duration || "—"],
    ["PUBLISHED", formatDate(m.publishedAt)],
  ];
  const statW = CONTENT_W / stats.length;
  const sy = CONTENT_TOP - 8;
  hairline(doc, CONTENT_X, sy, W - M, sy, 0.3);
  stats.forEach(([label, value], i) => {
    const x = CONTENT_X + i * statW;
    if (i > 0) hairline(doc, x, sy + 14, x, sy + 84, 0.14);
    const inset = i === 0 ? 0 : 18;
    drawText(doc, label, x + inset, sy + 16, { ...LABEL, size: 6.5, color: C.faint });
    const valueStyle: TextStyle = { font: "thin", size: 34, color: C.ink, oneLine: true };
    const fitted = textWidth(doc, value, valueStyle) > statW - inset - 8 ? { ...valueStyle, size: 22 } : valueStyle;
    drawText(doc, value, x + inset, sy + (fitted.size === 34 ? 36 : 44), fitted);
  });

  // Topics as outlined pills
  let ty = sy + 128;
  hairline(doc, CONTENT_X, ty, W - M, ty, 0.14);
  drawText(doc, "TOPICS", CONTENT_X, ty + 16, { ...LABEL, size: 6.5, color: C.faint });
  const pill: TextStyle = { font: "display", size: 11, color: C.ink, oneLine: true };
  let px = CONTENT_X;
  ty += 38;
  for (const topic of report.analysis.topics) {
    const label = clampLine(doc, topic, pill, CONTENT_W - 30);
    const pw = textWidth(doc, label, pill) + 30;
    if (px + pw > W - M) {
      px = CONTENT_X;
      ty += 34;
    }
    if (ty > CONTENT_BOTTOM - 120) break;
    doc.roundedRect(px, ty, pw, 24, 12).lineWidth(0.6).strokeColor(C.silver, 0.38).stroke();
    doc.circle(px + 12, ty + 12, 1.6).fillColor(C.cyan, 1).fill();
    doc.strokeOpacity(1);
    drawText(doc, label, px + 19, ty + 6.5, pill);
    px += pw + 10;
  }

  // Source video
  const ly = CONTENT_BOTTOM - 62;
  hairline(doc, CONTENT_X, ly, W - M, ly, 0.14);
  drawText(doc, "SOURCE VIDEO", CONTENT_X, ly + 16, { ...LABEL, size: 6.5, color: C.faint });
  const channel = clampLine(doc, m.channelTitle, { font: "display", size: 12, color: C.ink }, CONTENT_W / 2);
  drawText(doc, channel, CONTENT_X, ly + 32, { font: "display", size: 12, color: C.ink, oneLine: true });
  const urlStyle: TextStyle = { font: "mono", size: 9, color: C.cyan, oneLine: true, link: m.url, spacing: 0.3 };
  const urlW = textWidth(doc, m.url, urlStyle);
  drawText(doc, m.url, W - M - urlW - 18, ly + 34, urlStyle);
  chevron(doc, W - M - 8, ly + 38.5, 3.4);
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/** Builds the branded deck and returns the PDF bytes. */
export async function renderReportPdf(report: VideoReport): Promise<Buffer> {
  const assets = loadAssets();
  const doc = new PDFDocument({
    autoFirstPage: false,
    size: [W, H],
    margin: 0,
    font: assets.fonts.body as unknown as string, // avoids loading pdfkit's built-in Helvetica files
    info: {
      Title: `AIVA+ Video Intelligence Report: ${report.metadata.title}`,
      Author: "AIVA+",
      Subject: report.metadata.url,
      Keywords: report.analysis.topics.join(", "),
    },
  });
  for (const [key, buffer] of Object.entries(assets.fonts)) doc.registerFont(key, buffer);

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  // Decide the page list first so every page can show "NN / total".
  const { keyTakeaways, actionItems } = report.analysis;
  type PageFn = (ctx: PageContext) => void;
  const pages: PageFn[] = [coverPage];
  let section = 1;
  const summaryIndex = section++;
  pages.push((ctx) => summaryPage(ctx, summaryIndex));
  const takeawayIndex = section++;
  chunk(keyTakeaways, ITEMS_PER_PAGE).forEach((items, i, all) =>
    pages.push((ctx) =>
      itemsPage(ctx, takeawayIndex, "WHAT TO REMEMBER", all.length > 1 && i > 0 ? "Key takeaways, cont." : "Key takeaways",
        items, i * ITEMS_PER_PAGE + 1, "number")
    )
  );
  if (actionItems.length) {
    const actionIndex = section++;
    chunk(actionItems, ITEMS_PER_PAGE).forEach((items, i) =>
      pages.push((ctx) =>
        itemsPage(ctx, actionIndex, "WHAT TO DO NEXT", i > 0 ? "Action items, cont." : "Action items",
          items, i * ITEMS_PER_PAGE + 1, "check")
      )
    );
  }
  const glanceIndex = section++;
  pages.push((ctx) => glancePage(ctx, glanceIndex));

  pages.forEach((render, i) => {
    newPage(doc);
    render({ doc, report, pageNumber: i + 1, totalPages: pages.length });
  });
  doc.end();
  return done;
}

/** A filesystem-safe attachment name, e.g. "AIVA+ — How to Learn Anything.pdf". */
export function reportPdfFilename(report: VideoReport): string {
  const title = report.metadata.title
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
  return `AIVA+ — ${title || report.metadata.videoId}.pdf`;
}
