// pages/api/generate-css.js
// CSS-only, component-scoped generator with optional Critique→Fix cycles.
// Uses OpenAI Responses API with image+text input.
// Guardrails: use gradients only if the screenshot clearly has one.
// Includes model fallback if your project lacks GPT-5 access.

// IMPORTANT: we read the raw stream ourselves
export const config = { api: { bodyParser: false } };

import OpenAI from "openai";

// Preferred model first, then fallbacks your account likely has.
const MODEL_FALLBACKS = [
  "gpt-5",          // primary
  "gpt-5-mini",     // smaller/faster
  "gpt-4.1-mini",   // widely available 2025
  "gpt-4o-mini"     // broadly available legacy mini
];

// Token caps for Responses API (use max_output_tokens, not max_tokens)
const MAX_TOKENS_DRAFT = 1400;
const MAX_TOKENS_CRIT  = 800;
const MAX_TOKENS_FIX   = 1600;

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    // ----- Read raw body -----
    let raw = "";
    for await (const chunk of req) raw += chunk;

    let parsed;
    try { parsed = JSON.parse(raw || "{}"); }
    catch (e) { return res.status(400).json({ error: "Invalid JSON body", details: String(e?.message || e) }); }

    const {
      image,
      palette = [],
      scope = ".comp",
      component = "component",
      double_checks = 1,        // 1 fast pass by default (max 4)
      force_solid = false,      // client flatness hint
      solid_color = ""          // suggested hex when flat
    } = parsed;

    if (!image || typeof image !== "string" || !image.startsWith("data:image")) {
      return res.status(400).json({
        error: "Bad request",
        details: "Send { image: dataUrl, palette?, scope?, component?, double_checks?, force_solid?, solid_color? }"
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY not configured" });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // ---- choose a working model (probe fallbacks if needed) ----
    const model = await pickWorkingModel(client, MODEL_FALLBACKS);

    // ---------- DRAFT ----------
    let draft = await passDraft(client, model, {
      image,
      palette: Array.isArray(palette) ? palette : [],
      scope,
      component,
      force_solid: !!force_solid,
      solid_color: String(solid_color || "")
    });

    draft = enforceScope(draft, scope);
    let css = draft;
    const versions = [css];
    let lastCritique = "";

    // If caller marked flat, flatten any gradients that slipped in
    if (force_solid) {
      const hex = (String(solid_color || "").match(/^#([0-9a-f]{6}|[0-9a-f]{3})$/i) ? solid_color : null) || "#cccccc";
      css = solidifyCss(css, hex);
      versions[0] = css;
    }

    // ---------- Optional Critique→Fix (bounded 1..4) ----------
    const cycles = Math.max(1, Math.min(Number(double_checks) || 1, 4));
    for (let i = 1; i <= cycles - 1; i++) {
      lastCritique = await passCritique(client, model, {
        image, css, palette, scope, component, force_solid
      });

      let fixed = await passFix(client, model, {
        image, css, critique: lastCritique, palette, scope, component, force_solid, solid_color
      });

      fixed = enforceScope(fixed, scope);

      if (force_solid) {
        const hex = (String(solid_color || "").match(/^#([0-9a-f]{6}|[0-9a-f]{3})$/i) ? solid_color : null) || "#cccccc";
        fixed = solidifyCss(fixed, hex);
      }

      css = fixed;
      versions.push(css);
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      draft,
      css,
      versions,
      passes: 1 + Math.max(0, cycles - 1) * 2,
      palette,
      notes: force_solid ? "Flatness detected → gradients/gloss avoided." : lastCritique || "",
      scope,
      component,
      model
    });
  } catch (err) {
    console.error("generate-css error:", err);
    const status = Number(err?.status || err?.code || 500);
    const details =
      err?.error?.message ||
      err?.message ||
      (typeof err === "string" ? err : "") ||
      "Unknown error";
    const extra = safeStringify(err?.response?.data || err?.data || err?.cause || null);
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      error: "Failed to generate CSS.",
      details,
      extra
    });
  }
}

/* ================= helpers ================= */

function safeStringify(x) { try { return x ? JSON.stringify(x, null, 2) : undefined; } catch { return String(x); } }

function cssOnly(text = "") {
  return String(text).replace(/^```(?:css)?\s*/i, "").replace(/```$/i, "").trim();
}
function textOnly(s = "") { return String(s).replace(/```[\s\S]*?```/g, "").trim(); }

/** Scope enforcement: prefix top-level selectors with the scope (except :root/@rules). */
function enforceScope(inputCss = "", scope = ".comp") {
  let css = cssOnly(inputCss);
  css = css.replace(/(^|})\s*([^@}{]+?)\s*\{/g, (m, p1, selectors) => {
    const scoped = selectors
      .split(",")
      .map((s) => s.trim())
      .map((sel) => {
        if (!sel || sel.startsWith(scope) || sel.startsWith(":root")) return sel;
        return `${scope} ${sel}`;
      })
      .join(", ");
    return `${p1} ${scoped} {`;
  });
  return css.trim();
}

/** Flatten any gradients to a solid color & drop glossy ::after overlays. */
function solidifyCss(css = "", hex = "#cccccc") {
  const solid = `background-color: ${hex};`;
  return css
    .replace(/background\s*:\s*[^;]*gradient\([^;]*\)\s*;?/gi, solid)
    .replace(/background-image\s*:\s*[^;]*gradient\([^;]*\)\s*;?/gi, "background-image: none;")
    .replace(/::after\s*\{[^}]*\}/gi, (block) => {
      if (/background[^;]*gradient/i.test(block) || /rgba\([^)]*,\s*[^)]*,\s*[^)]*,\s*0(\.\d+)?\)/i.test(block)) return "";
      return block;
    });
}

/* ======== model picking with graceful fallback ======== */
async function pickWorkingModel(client, candidates) {
  // Try a tiny “ping” to each model until one works
  let lastErr;
  for (const m of candidates) {
    try {
      const ping = await client.responses.create({
        model: m,
        input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }],
        max_output_tokens: 1
      });
      if (ping?.output_text !== undefined) return m;
    } catch (e) {
      lastErr = e;
      // If the error is clearly “model does not exist / no access”, continue to next
      const msg = (e?.message || "").toLowerCase();
      if (msg.includes("does not exist") || msg.includes("you do not have access")) continue;
      // Other errors (quota, key invalid, etc.) → bubble up
      throw e;
    }
  }
  // If none worked, throw the last error so client sees a useful message
  throw lastErr || new Error("No working model from fallback list");
}

/* ================= model passes (Responses API) ================= */

async function passDraft(client, model, { image, palette, scope, component, force_solid, solid_color }) {
  const sys = [
    "You are a front-end CSS engine. Output VALID vanilla CSS only (no HTML/Markdown).",
    "You are styling a SINGLE UI COMPONENT, not a full page.",
    "All selectors MUST be under the provided SCOPE CLASS.",
    "Do NOT add resets/normalizers or page layout.",
    "Be minimal and faithful to the screenshot of the component.",
    "Gradient rule:",
    "- Only use linear-gradient if a clear gradient is visible.",
    "- If the background appears uniform (flat), use a single background-color.",
    "- Do NOT add glossy overlays (::after) unless the screenshot clearly shows a highlight."
  ].join("\n");

  const guard = force_solid
    ? [
        "",
        "The caller indicated the screenshot is flat:",
        "- Use a single background-color only.",
        "- Do NOT use gradients or glossy overlays.",
        solid_color ? `- Prefer this background-color if it matches: ${solid_color}` : ""
      ].join("\n")
    : "";

  const usr = [
    `SCOPE CLASS: ${scope}`,
    `COMPONENT TYPE (hint): ${component}`,
    "Requirements:",
    "- Prefix every selector with the scope (e.g., `.comp .btn`) or use the scope as the root.",
    "- No global selectors (html, body, *). No headers/footers/layout.",
    Array.isArray(palette) && palette.length ? `Optional palette tokens: ${palette.join(", ")}` : "Palette is optional.",
    guard,
    "Return CSS ONLY."
  ].join("\n");

  const r = await client.responses.create({
    model,
    instructions: sys,
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: usr },
        { type: "input_image", image_url: image } // data URL accepted
      ]
    }],
    max_output_tokens: MAX_TOKENS_DRAFT
  });

  const out = r?.output_text || "";
  return cssOnly(out);
}

async function passCritique(client, model, { image, css, palette, scope, component, force_solid }) {
  const sys = [
    "You are a strict component QA assistant. Output plain text (no CSS).",
    "Compare the screenshot WITH the CURRENT CSS for the SINGLE component.",
    "Identify concrete mismatches (size, spacing, radius, colors, borders, shadows, typography, hover, alignment).",
    "Keep it terse and actionable with target selectors when possible.",
    "Gradient rule:",
    "- Only use gradient if the screenshot clearly shows one.",
    "- If the screenshot looks flat and gradients are present, call that out."
  ].join("\n");

  const guard = force_solid ? "\nCaller indicated flat screenshot → flag any gradient/gloss usage." : "";

  const usr = [
    `SCOPE CLASS: ${scope}`,
    `COMPONENT TYPE (hint): ${component}`,
    "CURRENT CSS:",
    "```css",
    css,
    "```",
    Array.isArray(palette) && palette.length ? `Palette hint: ${palette.join(", ")}` : "",
    guard
  ].join("\n");

  const r = await client.responses.create({
    model,
    instructions: sys,
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: usr },
        { type: "input_image", image_url: image }
      ]
    }],
    max_output_tokens: MAX_TOKENS_CRIT
  });

  const out = r?.output_text || "";
  return textOnly(out);
}

async function passFix(client, model, { image, css, critique, palette, scope, component, force_solid, solid_color }) {
  const sys = [
    "Return CSS only (no HTML/Markdown). Overwrite the stylesheet to resolve the critique and better match the SINGLE component.",
    "All selectors must remain under the provided scope.",
    "No global selectors or page-level structures.",
    "Gradient rule:",
    "- Only use gradients if they are visually present in the screenshot.",
    "- If caller indicates flat, use a single background-color (no gloss)."
  ].join("\n");

  const guard = force_solid
    ? [
        "",
        "Caller indicated the screenshot is flat →",
        "- Use a single background-color.",
        "- Do NOT use gradients or glossy overlays.",
        solid_color ? `- Prefer: ${solid_color}` : ""
      ].join("\n")
    : "";

  const usr = [
    `SCOPE CLASS: ${scope}`,
    `COMPONENT TYPE (hint): ${component}`,
    "CRITIQUE:",
    critique || "(none)",
    "",
    "CURRENT CSS:",
    "```css",
    css,
    "```",
    Array.isArray(palette) && palette.length ? `Palette hint (optional): ${palette.join(", ")}` : "",
    guard
  ].join("\n");

  const r = await client.responses.create({
    model,
    instructions: sys,
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: usr },
        { type: "input_image", image_url: image }
      ]
    }],
    max_output_tokens: MAX_TOKENS_FIX
  });

  const out = r?.output_text || css;
  return cssOnly(out);
}
