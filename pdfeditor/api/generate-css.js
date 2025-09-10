// /api/generate-css.js
// CSS-only, component-scoped generator with N Critique→Fix cycles.
// Response: { draft, css, versions, passes, palette, notes, scope, component }

import OpenAI from "openai";

// Default model; override with OPENAI_MODEL if you want (e.g., gpt-5-mini)
const MODEL = process.env.OPENAI_MODEL || "gpt-5";

// If using Next.js Pages API
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
      double_checks = 6,      // 1–8
      scope = ".comp",
      component = "component",
    } = data || {};

    if (!image || typeof image !== "string" || !image.startsWith("data:image")) {
      return res.status(400).json({
        error:
          "Bad request: send JSON { image: <data:image/...;base64,>, palette?, double_checks?, scope?, component? } with Content-Type: application/json",
      });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY not configured" });
    }

    // Size guard (tweak to your runtime’s limits)
    const approxBytes = Buffer.byteLength(image, "utf8");
    const MAX_BYTES = 4.5 * 1024 * 1024;
    if (approxBytes > MAX_BYTES) {
      return res.status(413).json({ error: "Image too large. Keep under ~4MB." });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // ---------- DRAFT ----------
    let draft = await passDraft(client, { image, palette, scope, component });
    draft = enforceScope(draft, scope);
    const versions = [draft];
    let css = draft;
    let lastCritique = "";

    // ---------- CRITIQUE → FIX LOOPS ----------
    const cycles = Math.max(1, Math.min(Number(double_checks) || 1, 8));
    for (let i = 1; i <= cycles; i++) {
      lastCritique = await passCritique(client, { image, css, palette, scope, component, cycle: i, total: cycles });
      let fixed = await passFix(client, { image, css, critique: lastCritique, palette, scope, component, cycle: i, total: cycles });
      fixed = enforceScope(fixed, scope);
      css = fixed;
      versions.push(css);
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      draft,
      css,
      versions,
      passes: 1 + cycles * 2,
      palette,
      notes: lastCritique,
      scope,
      component,
    });
  } catch (err) {
    const status =
      err?.status ||
      err?.statusCode ||
      err?.response?.status ||
      (String(err?.message || "").includes("JSON body") ? 400 : 500);

    console.error("[/api/generate-css] Error:", err?.message || err);
    if (err?.response?.data) console.error("[openai-error-data]", err.response.data);

    return res.status(status).json({
      error: err?.message || "Failed to generate CSS.",
      details: err?.response?.data || undefined,
    });
  }
}

/* ================= helpers ================= */

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let raw = "";
  for await (const c of req) raw += c;
  if (!raw) throw new Error("JSON body required but request body was empty.");
  try { return JSON.parse(raw); } catch { throw new Error("Invalid JSON in request body."); }
}

function cssOnly(text = "") {
  return String(text).replace(/^```(?:css)?\s*/i, "").replace(/```$/i, "").trim();
}
function textOnly(s = "") {
  return String(s).replace(/```[\s\S]*?```/g, "").trim();
}

/** Prefix all non-@ rules (except :root) with the scope class. */
function enforceScope(inputCss = "", scope = ".comp") {
  let css = cssOnly(inputCss);
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

/** Get assistant text from Responses API result (robust across SDK shapes). */
function extractText(r) {
  if (typeof r?.output_text === "string") return r.output_text;
  try {
    const chunks = [];
    for (const item of (r?.output || [])) {
      if (item?.type === "message" && Array.isArray(item.content)) {
        for (const c of item.content) {
          // Some SDKs use 'output_text', some 'text'
          if (typeof c?.text === "string") chunks.push(c.text);
        }
      }
    }
    return chunks.join("");
  } catch {
    return "";
  }
}

/* ================= model passes (Responses API) ================= */

async function passDraft(client, { image, palette, scope, component }) {
  const sys =
    "You are a front-end CSS engine. Output VALID vanilla CSS only (no HTML/Markdown). " +
    "Input is a PHOTO or CROPPED SCREENSHOT of ONE UI COMPONENT (not a full page). " +
    "Job: reproduce only that component’s styles. " +
    "Hard rules: (1) All selectors scoped under the provided SCOPE CLASS; " +
    "(2) No global resets/layout/headers/footers; (3) Minimal, faithful, practical CSS.";

  const usr = [
    `SCOPE CLASS: ${scope}`,
    `COMPONENT TYPE (hint): ${component}`,
    "Study the SINGLE component in the photo and output CSS for that component ONLY.",
    "Do NOT invent page structures or unrelated styles. No body/html/universal selectors.",
    "Include hover/focus/disabled only if clearly implied.",
    palette?.length ? `Optional palette tokens (only if matching the look): ${palette.join(", ")}` : "No palette tokens required.",
    "Return CSS ONLY.",
  ].join("\n");

  const r = await client.responses.create({
    model: MODEL,
    max_output_tokens: 1400,
    input: [
      { role: "system", content: [{ type: "text", text: sys }] },
      {
        role: "user",
        content: [
          { type: "text", text: usr },
          { type: "input_image", image_url: image },
        ],
      },
    ],
  });

  return cssOnly(extractText(r) || "");
}

async function passCritique(client, { image, css, palette, scope, component, cycle, total }) {
  const sys =
    "You are a strict component QA assistant. Do NOT output CSS. " +
    "Compare the PHOTO/CROPPED SCREENSHOT of a SINGLE COMPONENT with the CURRENT CSS. " +
    "List concrete mismatches (alignment, spacing, radius, borders, colors, size, typography, hover/focus/disabled). " +
    "Ensure selectors remain under the provided scope. Be terse.";

  const usr = [
    `Critique ${cycle}/${total} (component-level only).`,
    `SCOPE CLASS: ${scope}`,
    `COMPONENT TYPE (hint): ${component}`,
    "List actionable corrections with target selectors when possible.",
    "",
    "CURRENT CSS:",
    "```css",
    css,
    "```",
    palette?.length ? `Palette hint: ${palette.join(", ")}` : "",
  ].join("\n");

  const r = await client.responses.create({
    model: MODEL,
    max_output_tokens: 900,
    input: [
      { role: "system", content: [{ type: "text", text: sys }] },
      {
        role: "user",
        content: [
          { type: "text", text: usr },
          { type: "input_image", image_url: image },
        ],
      },
    ],
  });

  return textOnly(extractText(r) || "");
}

async function passFix(client, { image, css, critique, palette, scope, component, cycle, total }) {
  const sys =
    "Return CSS only (no HTML/Markdown). " +
    "Overwrite the stylesheet to resolve the critique and better match the PHOTO/CROPPED SCREENSHOT of the SINGLE COMPONENT. " +
    "All selectors must remain under the provided scope. No global resets or page-level structures.";

  const usr = [
    `Fix ${cycle}/${total} for the component.`,
    `SCOPE CLASS: ${scope}`,
    `COMPONENT TYPE (hint): ${component}`,
    "Rules:",
    "- Keep all selectors under the scope.",
    "- No body/html/universal selectors. No page-level structures.",
    "- Adjust alignment, spacing, borders, radius, colors, typography, and states to match the photo.",
    "",
    "CRITIQUE:",
    critique || "(none)",
    "",
    "CURRENT CSS:",
    "```css",
    css,
    "```",
    palette?.length ? `Palette hint (optional): ${palette.join(", ")}` : "",
  ].join("\n");

  const r = await client.responses.create({
    model: MODEL,
    max_output_tokens: 1600,
    input: [
      { role: "system", content: [{ type: "text", text: sys }] },
      {
        role: "user",
        content: [
          { type: "text", text: usr },
          { type: "input_image", image_url: image },
        ],
      },
    ],
  });

  return cssOnly(extractText(r) || css);
}
