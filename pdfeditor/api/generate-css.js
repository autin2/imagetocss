// /api/generate-css.js
// Single-pass CSS generator for ONE component from an image (Responses API).
// Returns: { draft, css, versions, passes, palette, notes, scope, component }

import OpenAI from "openai";

// Default model (override with OPENAI_MODEL env if you want, e.g., "gpt-5-mini")
const MODEL = process.env.OPENAI_MODEL || "gpt-5";

// Next.js Pages API: we read the body stream ourselves
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

    // Size guard (keep uploads modest for speed)
    const approxBytes = Buffer.byteLength(image, "utf8");
    if (approxBytes > 4.5 * 1024 * 1024) {
      return res.status(413).json({ error: "Image too large. Keep under ~4MB." });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // ---------- SINGLE PASS ----------
    const cssRaw = await passSingle(client, { image, palette, scope, component });

    // Scope guard + light local "completion" if braces are clearly cut off
    let css = enforceScope(cssRaw, scope);
    css = closeObviousTruncation(css);

    // Shape matches your UI (draft == css; versions has only v0)
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
      err?.status ||
      err?.statusCode ||
      err?.response?.status ||
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

function cssFenceStrip(text = "") {
  return String(text).replace(/^```(?:css)?\s*/i, "").replace(/```$/i, "").trim();
}

/** Prefix all non-@ rules (except :root) with the scope class. */
function enforceScope(inputCss = "", scope = ".comp") {
  let css = String(inputCss || "").trim();
  css = css.replace(/(^|})\s*([^@}{]+?)\s*\{/g, (m, p1, selectors) => {
    const scoped = selectors
      .split(",")
      .map((s) => s.trim())
      .map((sel) => (!sel || sel.startsWith(scope) || sel.startsWith(":root")) ? sel : `${scope} ${sel}`)
      .join(", ");
    return `${p1} ${scoped} {`;
  });
  return css.trim();
}

/** If the model stopped in the middle of a block, add closing braces locally (no extra API call). */
function closeObviousTruncation(css) {
  let out = String(css || "").trim();
  if (!out) return out;

  // If it doesn't end with "}" but looks like rules exist, close until counts match
  const opens = (out.match(/{/g) || []).length;
  let closes = (out.match(/}/g) || []).length;

  while (closes < opens) {
    out += "\n}";
    closes++;
  }
  // Avoid dangling comma/colon at the very end
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

function between(text, a, b) {
  const i = text.indexOf(a); if (i === -1) return null;
  const j = text.indexOf(b, i + a.length); if (j === -1) return null;
  return text.slice(i + a.length, j);
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
    "Return the CSS wrapped EXACTLY between /*START_CSS*/ and /*END_CSS*/.";

  const usr = [
    `SCOPE CLASS: ${scope}`,
    `COMPONENT TYPE (hint): ${component}`,
    "Study the SINGLE component in the image and output CSS for that component only.",
    "No body/html/universal selectors. Use the scope for every selector.",
    palette?.length ? `Optional palette tokens (only if they match): ${palette.join(", ")}` : "No palette tokens required.",
    "Return CSS ONLY, between the markers.",
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

  const raw = extractText(r) || "";
  const boxed = between(raw, "/*START_CSS*/", "/*END_CSS*/");
  return (boxed ? boxed : cssFenceStrip(raw)).trim();
}
