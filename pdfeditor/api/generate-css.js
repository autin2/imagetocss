// /api/generate-css.js
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

    // ---- SINGLE PASS ----
    const raw = await passSingle(client, { image, palette, scope, component });

    // 1) Try markers, then fences, then guessed CSS
    let css = extractCss(raw);
    if (!css || !/{/.test(css)) css = guessCssFromRaw(raw);

    // 2) Strip any lingering markers
    css = stripMarkers(css);

    // 3) Enforce scope after cleaning
    css = enforceScope(css, scope);

    // 4) Sanitize (close braces, drop dangling last prop)
    css = sanitize(css);

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      draft: css,
      css,
      versions: [css],
      passes: 1,
      palette,
      notes: "",
      scope,
      component,
      raw_out: raw, // <— echo raw model text for the client to surface if css is empty
    });
  } catch (err) {
    const status = err?.status || err?.statusCode || err?.response?.status || 500;
    const toStr = (x) => { if (typeof x === "string") return x; try { return JSON.stringify(x, Object.getOwnPropertyNames(x), 2); } catch { return String(x); } };
    console.error("[/api/generate-css] Error:", toStr(err));
    const details = err?.response?.data ?? err?.data ?? undefined;
    return res.status(status).json({ error: toStr(err?.message) || "Failed to generate CSS.", details });
  }
}

/* ============ helpers ============ */
async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let raw = ""; for await (const c of req) raw += c;
  if (!raw) throw new Error("JSON body required but request body was empty.");
  try { return JSON.parse(raw); } catch { throw new Error("Invalid JSON in request body."); }
}

function extractCss(text = "") {
  // Prefer /*START_CSS*/.../*END_CSS*/
  const sRe = /\/\*\s*START_CSS\s*\*\//i;
  const eRe = /\/\*\s*END_CSS\s*\*\//ig;
  const s = sRe.exec(text);
  let e = null, m;
  while ((m = eRe.exec(text))) e = m; // last END
  if (s && e && e.index > s.index) return text.slice(s.index + s[0].length, e.index).trim();

  // Fallback to ```css ... ```
  const fence = /```css([\s\S]*?)```/i.exec(text);
  if (fence) return fence[1].trim();

  return ""; // let caller guess
}

function stripMarkers(s = "") {
  return s.replace(/\/\*\s*START_CSS\s*\*\/|\/\*\s*END_CSS\s*\*\//gi, "").trim();
}

/** Try to pull CSS-ish content even if the model ignored markers/fences. */
function guessCssFromRaw(raw = "") {
  let t = String(raw || "").trim();

  // Remove code fences of any language
  t = t.replace(/```[\w-]*\s*([\s\S]*?)```/g, "$1");

  // Remove leading non-CSS prose until we hit a selector-ish line
  const lines = t.split(/\r?\n/);
  const startIdx = lines.findIndex(L => /[.{#][^{]+\{/.test(L) || /^\s*@[a-z-]+\s/.test(L));
  if (startIdx > 0) t = lines.slice(startIdx).join("\n").trim();

  // If still no brace, give up
  if (!/{/.test(t)) return "";

  // Truncate to last '}' to avoid trailing prose
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

/** Close unmatched braces; drop one dangling property at the end if mid-line. */
function sanitize(css = "") {
  let out = String(css || "").trim();
  if (!out) return out;
  // Drop a half-finished last declaration
  out = out.replace(/([^\n{};]+:[^\n;{}]*)\s*$/m, (m) => /[;}]$/.test(m) ? m : "");
  // Close braces
  const opens = (out.match(/{/g) || []).length;
  let closes = (out.match(/}/g) || []).length;
  while (closes < opens) { out += "\n}"; closes++; }
  // Remove dangling comma/colon at very end
  out = out.replace(/[,:]\s*$/, "").trim();
  return out;
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
    "HARD RULES: (1) All selectors MUST be under the provided SCOPE CLASS; " +
    "           (2) No global resets/layout/headers/footers; " +
    "           (3) Keep CSS minimal, faithful, and practical; " +
    "FORMAT: First line EXACTLY '/*START_CSS*/', last line EXACTLY '/*END_CSS*/'.";

  const usr = [
    `SCOPE CLASS: ${scope}`,
    `COMPONENT TYPE (hint): ${component}`,
    "Study the SINGLE component in the image and output CSS for that component only.",
    "Prefer selectors like `.comp button`, `.comp .btn`, `.comp .card` etc. Avoid bare `.comp{}` unless it's truly the root box.",
    "No body/html/universal selectors.",
    palette?.length ? `Optional palette tokens (only if they match): ${palette.join(", ")}` : "No palette tokens required.",
    "Return CSS ONLY, wrapped between the required markers.",
  ].join("\n");

  const r = await client.responses.create({
    model: MODEL,
    max_output_tokens: 1600,
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
