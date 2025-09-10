// /api/generate-css.js
// Image → CSS for ONE COMPONENT with auto syntax-fix if needed (Responses API)

import OpenAI from "openai";

const MODEL = process.env.OPENAI_MODEL || "gpt-5";
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const data = await readJson(req);
    const { image, palette = [], scope = ".comp", component = "component" } = data || {};

    if (!image || typeof image !== "string" || !image.startsWith("data:image")) {
      return res.status(400).json({ error: "Bad request: send { image: dataUrl, palette?, scope?, component? }" });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY not configured" });
    }

    const approxBytes = Buffer.byteLength(image, "utf8");
    if (approxBytes > 4.5 * 1024 * 1024) {
      return res.status(413).json({ error: "Image too large. Keep under ~4MB." });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // ---------- 1) Single model pass ----------
    const raw = await passSingle(client, { image, palette, scope, component });

    // Extract→clean
    let css = extractCss(raw);
    if (!css || !/{/.test(css)) css = guessCssFromRaw(raw);
    css = stripMarkers(css);

    // Scope and sanitize
    css = enforceScope(css, scope);
    css = sanitize(css);

    // ---------- 2) If syntax looks off, run a tiny "syntax-fix" pass ----------
    if (needsSyntaxFix(css)) {
      const fixed = await passSyntaxFix(client, { css, scope });
      let cleaned = extractCss(fixed) || fixed;
      cleaned = stripMarkers(cleaned);
      cleaned = enforceScope(cleaned, scope);
      cleaned = sanitize(cleaned);
      if (cleaned && cleaned.length >= css.length / 2) {
        css = cleaned; // accept if it's not obviously worse
      }
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      draft: css,
      css,
      versions: [css],
      passes: 1,           // still a single visual pass; syntax-fix is tiny and style-neutral
      palette,
      notes: "",
      scope,
      component,
      raw_out: raw,
    });
  } catch (err) {
    const status = err?.status || err?.statusCode || err?.response?.status || 500;
    const toStr = (x) => { if (typeof x === "string") return x; try { return JSON.stringify(x, Object.getOwnPropertyNames(x), 2); } catch { return String(x); } };
    console.error("[/api/generate-css] Error:", toStr(err));
    const details = err?.response?.data ?? err?.data ?? undefined;
    return res.status(status).json({ error: toStr(err?.message) || "Failed to generate CSS.", details });
  }
}

/* ================= helpers ================= */

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let raw = ""; for await (const c of req) raw += c;
  if (!raw) throw new Error("JSON body required but request body was empty.");
  try { return JSON.parse(raw); } catch { throw new Error("Invalid JSON in request body."); }
}

// Prefer /*START_CSS*/.../*END_CSS*/, then ```css fences
function extractCss(text = "") {
  const sRe = /\/\*\s*START_CSS\s*\*\//i;
  const eRe = /\/\*\s*END_CSS\s*\*\//ig;
  const s = sRe.exec(text);
  let e = null, m;
  while ((m = eRe.exec(text))) e = m;
  if (s && e && e.index > s.index) return text.slice(s.index + s[0].length, e.index).trim();

  const fence = /```css([\s\S]*?)```/i.exec(text);
  if (fence) return fence[1].trim();

  return "";
}

// Remove any lingering markers defensively
function stripMarkers(s = "") {
  return s.replace(/\/\*\s*START_CSS\s*\*\/|\/\*\s*END_CSS\s*\*\//gi, "").trim();
}

/** Fallback: pull CSS-ish content even if model ignored markers/fences. */
function guessCssFromRaw(raw = "") {
  let t = String(raw || "").trim();
  t = t.replace(/```[\w-]*\s*([\s\S]*?)```/g, "$1");
  const lines = t.split(/\r?\n/);
  const startIdx = lines.findIndex(L => /[.{#][^{]+\{/.test(L) || /^\s*@[a-z-]+\s/.test(L));
  if (startIdx > 0) t = lines.slice(startIdx).join("\n").trim();
  if (!/{/.test(t)) return "";
  const lastBrace = t.lastIndexOf("}");
  if (lastBrace > 0) t = t.slice(0, lastBrace + 1);
  return t.trim();
}

/** Scope all non-@ top-level selectors (except :root) under the scope class. */
function enforceScope(inputCss = "", scope = ".comp") {
  let css = String(inputCss || "").trim();
  css = css.replace(/(^|})\s*([^@}{]+?)\s*\{/g, (m, p1, selectors) => {
    const scoped = selectors
      .split(",")
      .map((s) => s.trim())
      .map((sel) => (!sel || sel.startsWith(scope) || sel.startsWith(":root")) ? sel : `${scope} ${sel}`)
      .filter(Boolean)
      .join(", ");
    return `${p1} ${scoped} {`;
  });
  return css.trim();
}

/** Close unmatched braces; remove one dangling declaration at the end if mid-line; trim stray trailing comma/colon. */
function sanitize(css = "") {
  let out = String(css || "").trim();
  if (!out) return out;

  // Drop a half-finished last declaration (e.g., "background: linear-gradient(to bottom")
  out = out.replace(/([^\n{};]+:[^\n;{}]*)\s*$/m, (m) => /[;}]$/.test(m) ? m : "");

  // Close braces
  const opens = (out.match(/{/g) || []).length;
  let closes = (out.match(/}/g) || []).length;
  while (closes < opens) { out += "\n}"; closes++; }

  // Remove dangling comma/colon at very end
  out = out.replace(/[,:]\s*$/, "").trim();
  return out;
}

/** Detect missing semicolons, missing property names, or bracket imbalance. */
function needsSyntaxFix(css = "") {
  const t = String(css || "");
  // brace imbalance
  const opens = (t.match(/{/g) || []).length;
  const closes = (t.match(/}/g) || []).length;
  if (opens !== closes) return true;

  // Simple state machine to catch "value lines" without a property (like your box-shadow list)
  const lines = t.split(/\r?\n/);
  let depth = 0, openDecl = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\/\*.*?\*\//g, "").trim();
    if (!line) continue;

    // brace tracking
    for (const ch of line) {
      if (ch === "{") { depth++; }
      if (ch === "}") { depth = Math.max(0, depth - 1); openDecl = false; }
    }
    if (depth === 0) continue;
    if (line.includes("{") || line.includes("}")) continue; // selector or close

    // declaration logic
    const hasColon = line.includes(":");
    const endsSemi  = /;\s*$/.test(line);
    const startsLikeValue = /^(inset\b|[-.\d]|#|rgba?\(|hsla?\(|var\(|url\()/.test(line);

    if (!openDecl) {
      if (!hasColon && startsLikeValue) return true; // value with no property (your case)
      if (hasColon && !endsSemi && !/,\s*$/.test(line)) openDecl = true; // multi-line value
      if (hasColon && endsSemi) openDecl = false;
    } else {
      // we're in a multi-line value until we hit ;
      if (endsSemi) openDecl = false;
    }

    // common easy miss: a line with colon but no trailing ;
    if (hasColon && !endsSemi && !openDecl) return true;
  }
  return false;
}

/* ===== Responses API glue ===== */

function extractText(r) {
  if (typeof r?.output_text === "string") return r.output_text;
  const chunks = [];
  try {
    if (Array.isArray(r?.output)) {
      for (const item of r.output) {
        if (item?.type === "output_text" && typeof item?.text === "string") chunks.push(item.text);
        if (item?.type === "message" && Array.isArray(item?.content)) {
          for (const c of item.content) if (c?.type === "output_text" && typeof c?.text === "string") chunks.push(c.text);
        }
      }
    }
  } catch {}
  return chunks.join("");
}

async function passSingle(client, { image, palette, scope, component }) {
  const sys =
    "You are a front-end CSS engine. Output VALID vanilla CSS only (no HTML/Markdown). " +
    "Input is a PHOTO or CROPPED SCREENSHOT of ONE UI COMPONENT (not a full page). " +
    "Your job is to reproduce only that component’s styles. " +
    "HARD RULES: " +
    "(1) Every declaration must be 'property: value;' (with the semicolon), " +
    "(2) Do not emit value lists without a property name, " +
    "(3) All selectors MUST be under the provided SCOPE CLASS, " +
    "(4) No global resets/layout/headers/footers. " +
    "FORMAT: First line EXACTLY '/*START_CSS*/', last line EXACTLY '/*END_CSS*/'.";

  const usr = [
    `SCOPE CLASS: ${scope}`,
    `COMPONENT TYPE (hint): ${component}`,
    "Study the SINGLE component in the image and output CSS for that component only.",
    "Prefer selectors like `.comp button`, `.comp .btn`, `.comp .card`, etc. Avoid bare `.comp{}` unless styling the root component box.",
    palette?.length ? `Optional palette tokens (only if they match): ${palette.join(", ")}` : "No palette tokens required.",
    "Return CSS ONLY, wrapped between the required markers.",
  ].join("\n");

  const r = await client.responses.create({
    model: MODEL,
    max_output_tokens: 1400,
    input: [
      { role: "system", content: [{ type: "input_text", text: sys }] },
      { role: "user",   content: [
          { type: "input_text",  text: usr },
          { type: "input_image", image_url: image },
        ] }
    ],
  });

  return extractText(r) || "";
}

// Small, fast pass: fix syntax ONLY (no design changes)
async function passSyntaxFix(client, { css, scope }) {
  const sys =
    "You are a strict CSS validator/formatter. " +
    "Task: FIX SYNTAX ONLY (missing property names, missing semicolons, unbalanced braces). " +
    "Do not alter styles, values, or selectors except to correct syntax. " +
    "All selectors must remain under the provided scope. " +
    "Output CSS ONLY wrapped between /*START_CSS*/ and /*END_CSS*/.";

  const usr = [
    `SCOPE CLASS: ${scope}`,
    "Fix syntax issues ONLY in this CSS:",
    "```css",
    css,
    "```",
    "Ensure: every declaration is 'property: value;', no dangling tokens, and braces are balanced."
  ].join("\n");

  const r = await client.responses.create({
    model: MODEL,
    max_output_tokens: 600,
    input: [
      { role: "system", content: [{ type: "input_text", text: sys }] },
      { role: "user",   content: [{ type: "input_text", text: usr }] }
    ],
  });

  return extractText(r) || "";
}
