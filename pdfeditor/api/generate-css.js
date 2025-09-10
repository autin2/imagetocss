// /api/generate-css.js
// CSS-only, component-scoped generator with optional Critique→Fix cycles.
// Guardrails: only use gradients if the image clearly has one.
// POST body:
// {
//   image: "data:image/...",
//   palette?: string[],
//   scope?: ".comp",
//   component?: "button" | "card" | "input" | string,
//   double_checks?: number,        // default 1 (1..4)
//   force_solid?: boolean,         // client "flatness" detector hint
//   solid_color?: string           // suggested hex when flat, e.g. "#3b82f6"
// }
//
// Response: {
//   draft, css, versions, passes, palette, notes, scope, component
// }

import OpenAI from "openai";

// === Model selection ===
// Use a GPT-5 Responses model. If you need cheaper, switch to "gpt-5.1-mini".
const MODEL = "gpt-5.1";

// Hard caps to avoid runaway cost/time.
const MAX_TOKENS_DRAFT   = 1400;
const MAX_TOKENS_CRIT    = 800;
const MAX_TOKENS_FIX     = 1600;

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    // ---- Parse raw JSON (works on Vercel/Node streams) ----
    let body = "";
    for await (const chunk of req) body += chunk;

    let parsed;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      return res.status(400).json({ error: "Invalid JSON body" });
    }

    const {
      image,
      palette = [],
      scope = ".comp",
      component = "component",
      double_checks = 1,              // default to 1 (fast)
      force_solid = false,            // client-side flatness hint
      solid_color = ""                // optional suggested hex when flat
    } = parsed;

    if (!image || typeof image !== "string" || !image.startsWith("data:image")) {
      return res.status(400).json({
        error:
          "Send { image: dataUrl, palette?, scope?, component?, double_checks?, force_solid?, solid_color? }",
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY not configured" });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // ---- DRAFT (first pass) ----
    let draft = await passDraft(client, {
      image,
      palette: Array.isArray(palette) ? palette : [],
      scope,
      component,
      force_solid: !!force_solid,
      solid_color: String(solid_color || ""),
    });

    draft = enforceScope(draft, scope);
    let css = draft;
    const versions = [css];
    let lastCritique = "";

    // If caller says "flat", flatten any gradients the model added anyway
    if (force_solid) {
      const hex =
        (String(solid_color || "").match(/^#([0-9a-f]{6}|[0-9a-f]{3})$/i)
          ? solid_color
          : null) || "#cccccc";
      css = solidifyCss(css, hex);
      versions[0] = css;
    }

    // ---- Optional Critique → Fix cycles (bounded 1..4) ----
    const cycles = Math.max(1, Math.min(Number(double_checks) || 1, 4));
    for (let i = 1; i <= cycles - 1; i++) {
      // Only loop if cycles > 1; otherwise it's just the draft
      lastCritique = await passCritique(client, {
        image,
        css,
        palette,
        scope,
        component,
        force_solid,
      });

      let fixed = await passFix(client, {
        image,
        css,
        critique: lastCritique,
        palette,
        scope,
        component,
        force_solid,
        solid_color,
      });

      fixed = enforceScope(fixed, scope);

      if (force_solid) {
        const hex =
          (String(solid_color || "").match(/^#([0-9a-f]{6}|[0-9a-f]{3})$/i)
            ? solid_color
            : null) || "#cccccc";
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
      passes: 1 + Math.max(0, cycles - 1) * 2, // 1 draft + (critique+fix)*(cycles-1)
      palette,
      notes: force_solid ? "Flatness detected → gradients/gloss avoided." : lastCritique || "",
      scope,
      component,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to generate CSS." });
  }
}

/* ===================== helpers ===================== */

/** Strip ``` fences and return CSS text only. */
function cssOnly(text = "") {
  return String(text)
    .replace(/^```(?:css)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

/** Strip any code blocks and return plain text (for critique). */
function textOnly(s = "") {
  return String(s).replace(/```[\s\S]*?```/g, "").trim();
}

/**
 * Scope enforcement:
 * Prefix top-level selectors with the provided scope (except :root and @rules).
 * This is a pragmatic regex-based approach that covers most outputs.
 */
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

/**
 * Flatten any accidental gradients into a single solid background color,
 * and drop glossy overlays (::after) that imply highlights.
 */
function solidifyCss(css = "", hex = "#cccccc") {
  const solid = `background-color: ${hex};`;
  return css
    // Replace any background/background-image with gradients
    .replace(/background\s*:\s*[^;]*gradient\([^;]*\)\s*;?/gi, solid)
    .replace(/background-image\s*:\s*[^;]*gradient\([^;]*\)\s*;?/gi, "background-image: none;")
    // Remove gradient-ish ::after overlays (typical gloss)
    .replace(/::after\s*\{[^}]*\}/gi, (block) => {
      if (/background[^;]*gradient/i.test(block) || /rgba\([^)]*,\s*[^)]*,\s*[^)]*,\s*0(\.\d+)?\)/i.test(block)) {
        return "";
      }
      return block;
    });
}

/* ===================== model passes ===================== */

/**
 * DRAFT: produce minimal, faithful CSS for a single component.
 * Guardrails: only use gradient if clearly visible; respect force_solid/solid_color.
 */
async function passDraft(client, { image, palette, scope, component, force_solid, solid_color }) {
  const sys = [
    "You are a front-end CSS engine. Output VALID vanilla CSS only (no HTML/Markdown).",
    "You are styling a SINGLE UI COMPONENT, not a full page.",
    "All selectors MUST be under the provided SCOPE CLASS.",
    "Do NOT add resets/normalizers or page layout.",
    "Be minimal and faithful to the screenshot of the component.",
    "Gradient rule:",
    "- Only use linear-gradient if a clear gradient is visible.",
    "- If the background appears uniform (flat), use a single background-color.",
    "- Do NOT add glossy overlays (::after) unless the screenshot clearly shows a highlight.",
  ].join("\n");

  const guard = force_solid
    ? [
        "",
        "The caller indicated the screenshot is flat:",
        "- Use a single background-color only.",
        "- Do NOT use gradients or glossy overlays.",
        solid_color ? `- Prefer this background-color if it matches: ${solid_color}` : "",
      ].join("\n")
    : "";

  const usr = [
    `SCOPE CLASS: ${scope}`,
    `COMPONENT TYPE (hint): ${component}`,
    "Requirements:",
    "- Prefix every selector with the scope (e.g., `.comp .btn`) or use the scope as the root.",
    "- No global selectors (html, body, *). No headers/footers/layout.",
    palette?.length ? `Optional palette tokens: ${palette.join(", ")}` : "Palette is optional.",
    guard,
    "Return CSS ONLY.",
  ].join("\n");

  const r = await client.responses.create({
    model: MODEL,
    instructions: sys,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: usr },
          { type: "input_image", image_url: image },
        ],
      },
    ],
    max_output_tokens: MAX_TOKENS_DRAFT,
  });

  const out = r?.output_text || "";
  return cssOnly(out);
}

/**
 * CRITIQUE: compare screenshot vs. current CSS. Output terse, actionable notes.
 * Re-assert gradient rule so it flags accidental gradients for flat images.
 */
async function passCritique(client, { image, css, palette, scope, component, force_solid }) {
  const sys = [
    "You are a strict component QA assistant. Output plain text (no CSS).",
    "Compare the screenshot WITH the CURRENT CSS for the SINGLE component.",
    "Identify concrete mismatches (size, spacing, radius, colors, borders, shadows, typography, hover, alignment).",
    "Keep it terse and actionable with target selectors when possible.",
    "Gradient rule:",
    "- Only use gradient if the screenshot clearly shows one.",
    "- If the screenshot looks flat and gradients are present, call that out.",
  ].join("\n");

  const guard = force_solid
    ? "\nCaller indicated flat screenshot → flag any gradient/gloss usage."
    : "";

  const usr = [
    `SCOPE CLASS: ${scope}`,
    `COMPONENT TYPE (hint): ${component}`,
    "CURRENT CSS:",
    "```css",
    css,
    "```",
    palette?.length ? `Palette hint: ${palette.join(", ")}` : "",
    guard,
  ].join("\n");

  const r = await client.responses.create({
    model: MODEL,
    instructions: sys,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: usr },
          { type: "input_image", image_url: image },
        ],
      },
    ],
    max_output_tokens: MAX_TOKENS_CRIT,
  });

  const out = r?.output_text || "";
  return textOnly(out);
}

/**
 * FIX: overwrite CSS to resolve critique and better match screenshot.
 * Re-assert scoping and gradient guardrails.
 */
async function passFix(client, {
  image,
  css,
  critique,
  palette,
  scope,
  component,
  force_solid,
  solid_color,
}) {
  const sys = [
    "Return CSS only (no HTML/Markdown). Overwrite the stylesheet to resolve the critique and better match the SINGLE component.",
    "All selectors must remain under the provided scope.",
    "No global selectors or page-level structures.",
    "Gradient rule:",
    "- Only use gradients if they are visually present in the screenshot.",
    "- If caller indicates flat, use a single background-color (no gloss).",
  ].join("\n");

  const guard = force_solid
    ? [
        "",
        "Caller indicated the screenshot is flat →",
        "- Use a single background-color.",
        "- Do NOT use gradients or glossy overlays.",
        solid_color ? `- Prefer: ${solid_color}` : "",
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
    palette?.length ? `Palette hint (optional): ${palette.join(", ")}` : "",
    guard,
  ].join("\n");

  const r = await client.responses.create({
    model: MODEL,
    instructions: sys,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: usr },
          { type: "input_image", image_url: image },
        ],
      },
    ],
    max_output_tokens: MAX_TOKENS_FIX,
  });

  const out = r?.output_text || css;
  return cssOnly(out);
}
