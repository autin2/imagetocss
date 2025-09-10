// /api/generate-css.js
// Single-pass CSS generator for ONE component from an image (Responses API).
// Fixes: strips START/END markers before scoping; robust extraction; local sanitize.
// Returns: { draft, css, versions, passes, palette, notes, scope, component }

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
    const {
      image,
      palette = [],
      scope = ".comp",
      component = "component",
    } = data || {};

    if (!image || typeof image !== "string" || !image.startsWith("data:image")) {
      return res.status(400).json({
        error:
          "Bad request: send JSON { image: <data:image/...;base64,>, palette?, scope?, component? } with Content-Type: application/json",
      });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY not configured" });
    }

    // Size guard
    const approxBytes = Buffer.byteLength(image, "utf8");
    if (approxBytes > 4.5 * 1024 * 1024) {
      return res.status(413).json({ error: "Image too large. Keep under ~4MB." });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // ----- SINGLE PASS -----
    const raw = await passSingle(client, { image, palette, scope, component });

    // 1) Extract inside markers (robust), or code fence, or raw
    let css = extractCss(raw);

    // 2) Strip any stray markers/comments (defensive)
    css = stripMarkers(css);

    // 3) Scope after markers are gone (prevents `.comp /*START_CSS*/` issue)
    css = enforceScope(css, scope);

    // 4) Sanitize: close braces & trim dangling property if cut mid-line
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
    });
  } catch (err) {
    const status =
      err?.status || err?.statusCode || err?.response?.status ||
      (String(err?.message || "").includes("JSON body") ? 400 : 500);

    const toStr = (x) => {
      if (typeof x === "string") return x;
      try { return JSON.stringify(x, Object.getOwnPropertyNames(x), 2); }
      catch { return String(x); }
    };

    console.error("[/api/generate-css] Error:", toStr(err));
    const details = err?.response?.data ?? err?.data ?? undefined;

    return res.status(status).json({
      error: toStr(err?.message) || toStr(details) || "Failed to generate CSS.",
      details,
    });
  }
}

/* ================= helpers ================= */

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let raw = ""; for await (const c of req) raw += c;
  if (!raw) throw new Error("JSON body required but request body was empty.");
  try { return JSON.parse(raw); } catch { throw new Error("Invalid JSON in request body."); }
}

// Robust marker extract (handles spaces/case; picks the last END marker if multiple)
function extractCss(text = "") {
  const sRe = /\/\*\s*START_CSS\s*\*\//i;
  const eRe = /\/\*\s*END_CSS\s*\*\//ig;
  const s = sRe.exec(text);
  let e = null, m;
  while ((m = eRe.exec(text))) e = m; // last END
  if (s && e && e.index > s.index) {
    return text.slice(s.index + s[0].length, e.index).trim();
  }
  // Fallback: ```css ... ```
  const fence = /```css([\s\S]*?)```/i.exec(text);
  if (fence) return fence[1].trim();
  // Last resort: return the whole thing but trimmed
  return String(text).trim();
}

// Remove any lingering START/END markers defensively
function stripMarkers(s = "") {
  return s.replace(/\/\*\s*START_CSS\s*\*\/|\/\*\s*END_CSS\s*\*\//gi, "").trim();
}

/** Scope all non-@top-level selectors (except :root) under the scope class. */
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

// If model cuts off: close unmatched braces and drop one dangling declaration if needed
function sanitize(css = "") {
  let out = String(css || "").trim();
  if (!out) return out;

  // If last declaration is cut (has ":" but no ";" before line end), drop it
  out = out.replace(/([^\n{};]+:[^\n;{}]*)\s*$/m, (m) => {
    // If it already ends with ; or }, keep it
    return /[;}]$/.test(m) ? m : "";
  }).trim();

  // Close unmatched braces
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

/* ================= single pass ================= */

async function passSingle(client, { image, palette, scope, component }) {
  const sys =
    "You are a front-end CSS engine. Output VALID vanilla CSS only (no HTML/Markdown). " +
    "Input is a PHOTO or CROPPED SCREENSHOT of ONE UI COMPONENT (not a full page). " +
    "Your job is to reproduce only that component’s styles. " +
    "HARD RULES: " +
    "(1) All selectors MUST be under the provided SCOPE CLASS; " +
    "(2) No global resets/layout/headers/footers; " +
    "(3) Keep CSS minimal, faithful, and practical; " +
    "OUTPUT FORMAT: first line EXACTLY '/*START_CSS*/', last line EXACTLY '/*END_CSS*/'. " +
    "No other content on those lines.";

  const usr = [
    `SCOPE CLASS: ${scope}`,
    `COMPONENT TYPE (hint): ${component}`,
    "Study the SINGLE component in the image and output CSS for that component only.",
    "Prefer selectors like `.comp button`, `.comp .btn`, `.comp .card`, etc., not bare `.comp{}` unless it's truly the root.",
    "No body/html/universal selectors.",
    palette?.length ? `Optional palette tokens (only if they match): ${palette.join(", ")}` : "No palette tokens required.",
    "Return CSS ONLY, wrapped between the required markers.",
  ].join("\n");

  const r = await client.responses.create({
    model: MODEL,
    max_output_tokens: 1400,
    input: [
      { role: "system", content: [{ type: "input_text", text: sys }] },
      {
        role: "user",
        content: [
          { type: "input_text", text: usr },
          { type: "input_image", image_url: image },
        ],
      },
    ],
  });

  return extractText(r) || "";
}
