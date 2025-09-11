// /api/generate-css.js
// CSS-only, component-scoped generator with critique→fix loops, model fallback,
// robust error reporting, and post-process autofixes.
// Response: { draft, css, versions, passes, palette, notes, scope, component }
//
// Requires: npm i openai@^4
// ENV: OPENAI_API_KEY (required)
//      OPENAI_MODEL (optional) e.g. gpt-5.1-mini or gpt-4o-mini

import OpenAI from "openai";

/* ==========================
   Model choices & defaults
   ========================== */

const MODEL_CHAIN = [
  process.env.OPENAI_MODEL, // explicit override (first if present)
  "gpt-5-mini",           // preferred if your account has it
  "gpt-4o-mini"             // safe fallback with vision
].filter(Boolean);

const DEFAULT_MODEL = MODEL_CHAIN[0] || "gpt-4o-mini";

/* ==========================
   HTTP handler
   ========================== */

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed", details: "Use POST /api/generate-css" });
    }

    // Stream-safe body parse (Vercel / Node)
    let raw = "";
    for await (const chunk of req) raw += chunk;

    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; }
    catch (e) {
      return sendError(res, 400, "Bad JSON", e?.message, "Send Content-Type: application/json and valid JSON.");
    }

    const {
      image,
      palette = [],
      double_checks = 1,           // 1–8
      scope = ".comp",
      component = "component",
      force_solid = false,         // flatten gradients
      solid_color = "",            // optional color for flattening
      minify = false,              // optional minify
      debug = false                // return additional internals if needed
    } = body;

    if (!image || typeof image !== "string" || !/^data:image\//i.test(image)) {
      return sendError(res, 400, "Invalid 'image'", "Expected a data URL (data:image/*;base64,...)");
    }
    if (!process.env.OPENAI_API_KEY) {
      return sendError(res, 500, "OPENAI_API_KEY not configured", "Set OPENAI_API_KEY in environment.");
    }

    const cycles = clampInt(double_checks, 1, 8);

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const { callWithModel } = makeOpenAI(client);

    // ---------- DRAFT ----------
    let draft = await callWithModel("draft", {
      image, palette, scope, component
    });

    draft = enforceScope(draft, scope);
    let css = draft;
    const versions = [draft];
    let lastCritique = "";

    // ---------- CRITIQUE→FIX ----------
    for (let i = 1; i <= cycles; i++) {
      lastCritique = await callWithModel("critique", {
        image, css, palette, scope, component, cycle: i, total: cycles
      });

      let fixed = await callWithModel("fix", {
        image, css, critique: lastCritique, palette, scope, component, cycle: i, total: cycles
      });

      fixed = enforceScope(fixed, scope);
      css = fixed;
      versions.push(css);
    }

    // ---------- POST PROCESSING ----------
    css = cssOnly(css);
    css = autofixCss(css);
    if (force_solid) css = flattenGradients(css, solid_color);
    if (minify) css = minifyCss(css);

    const payload = {
      draft,
      css,
      versions,
      passes: 1 + cycles * 2, // 1 draft + (critique+fix)*cycles
      palette,
      notes: lastCritique,
      scope,
      component
    };

    if (debug) payload.debug = { model_chain: MODEL_CHAIN, default_model: DEFAULT_MODEL };

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(payload);

  } catch (err) {
    return sendError(res, 500, "Failed to generate CSS.", extractErrMsg(err), "Check server logs for stack trace.");
  }
}

/* ==========================
   OpenAI glue
   ========================== */

/**
 * We stick to Chat Completions (vision) to avoid Responses-API quirks.
 * Will try each model in MODEL_CHAIN until one works.
 */
function makeOpenAI(client) {
  async function tryEachModel(run) {
    let lastErr;
    for (const model of (MODEL_CHAIN.length ? MODEL_CHAIN : [DEFAULT_MODEL])) {
      try {
        const data = await run(model);
        return { model, data };
      } catch (e) {
        lastErr = e;
        const msg = String(e?.message || "");
        const soft =
          e?.status === 404 ||
          /does not exist/i.test(msg) ||
          /unknown model/i.test(msg) ||
          /restricted/i.test(msg);
        if (!soft) throw e; // real error, stop trying
        // else fall through to next model
      }
    }
    throw lastErr || new Error("No usable model found");
  }

  const callWithModel = async (kind, args) => {
    const { model } = await tryEachModel(async (m) => m); // resolves usable model

    const sysDraft =
      "You are a front-end CSS engine. Output VALID vanilla CSS only (no HTML/Markdown). " +
      "You are styling a SINGLE UI COMPONENT (not a full page). " +
      "All selectors MUST be scoped under the provided SCOPE CLASS. " +
      "Do NOT target html/body/universal selectors or add resets/normalizers. " +
      "Keep styles minimal and faithful to the screenshot of the component.";

    const sysCrit =
      "You are a strict component QA assistant. Do NOT output CSS. " +
      "Compare the screenshot WITH the CURRENT component CSS. " +
      "Identify concrete mismatches (alignment, spacing, radius, borders, colors, size, typography, hover states). " +
      "Ensure selectors remain under the provided scope. Be terse.";

    const sysFix =
      "Return CSS only (no HTML/Markdown). Overwrite the stylesheet to resolve the critique " +
      "and better match the screenshot of the SINGLE COMPONENT. " +
      "All selectors must remain under the provided scope. No global resets.";

    if (kind === "draft") {
      const usr =
        [
          `SCOPE CLASS: ${args.scope}`,
          `COMPONENT TYPE (hint): ${args.component}`,
          "Task: study the screenshot region and produce CSS for ONLY that component.",
          "Requirements:",
          "- Prefix all selectors with the scope (e.g., `.comp .btn`), or use the scope root (e.g., `.comp{...}`).",
          "- No global resets. No page layout. No headers/footers/cookie banners.",
          "- If gradients are visible, use linear-gradient; if not, use a solid background-color.",
          args.palette?.length ? `Optional palette tokens: ${args.palette.join(", ")}` : "Palette: optional.",
          "Return CSS ONLY."
        ].join("\n");

      const r = await client.chat.completions.create({
        model,
        temperature: 0.2,
        max_tokens: 1200,
        messages: [
          { role: "system", content: sysDraft },
          {
            role: "user",
            content: [
              { type: "text", text: usr },
              { type: "image_url", image_url: { url: args.image } }
            ]
          }
        ]
      });
      return cssOnly(r?.choices?.[0]?.message?.content || "");
    }

    if (kind === "critique") {
      const usr =
        [
          `Critique ${args.cycle}/${args.total} (component-level only).`,
          `SCOPE CLASS: ${args.scope}`,
          `COMPONENT TYPE (hint): ${args.component}`,
          "List actionable corrections with target selectors when possible.",
          "",
          "CURRENT CSS:",
          "```css",
          args.css,
          "```",
          args.palette?.length ? `Palette hint: ${args.palette.join(", ")}` : ""
        ].join("\n");

      const r = await client.chat.completions.create({
        model,
        temperature: 0.0,
        max_tokens: 700,
        messages: [
          { role: "system", content: sysCrit },
          {
            role: "user",
            content: [
              { type: "text", text: usr },
              { type: "image_url", image_url: { url: args.image } }
            ]
          }
        ]
      });
      return textOnly(r?.choices?.[0]?.message?.content || "");
    }

    if (kind === "fix") {
      const usr =
        [
          `Fix ${args.cycle}/${args.total} for the component.`,
          `SCOPE CLASS: ${args.scope}`,
          `COMPONENT TYPE (hint): ${args.component}`,
          "Rules:",
          "- Keep all selectors under the scope.",
          "- No body/html/universal selectors. No page-level structures.",
          "- Adjust alignment, spacing, borders, radius, colors, typography, hover to match the screenshot.",
          "",
          "CRITIQUE:",
          args.critique || "(none)",
          "",
          "CURRENT CSS:",
          "```css",
          args.css,
          "```",
          args.palette?.length ? `Palette hint (optional): ${args.palette.join(", ")}` : ""
        ].join("\n");

      const r = await client.chat.completions.create({
        model,
        temperature: 0.1,
        max_tokens: 1400,
        messages: [
          { role: "system", content: sysFix },
          {
            role: "user",
            content: [
              { type: "text", text: usr },
              { type: "image_url", image_url: { url: args.image } }
            ]
          }
        ]
      });
      return cssOnly(r?.choices?.[0]?.message?.content || args.css);
    }

    throw new Error(`Unknown call kind: ${kind}`);
  };

  return { callWithModel };
}

/* ==========================
   Helpers & post-processing
   ========================== */

function clampInt(v, min, max) {
  const n = Number(v);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function sendError(res, status, error, details, hint) {
  const payload = { error: String(error || "Unknown") };
  if (details) payload.details = String(details);
  if (hint) payload.hint = String(hint);
  res.status(status).json(payload);
}

function extractErrMsg(err) {
  if (err?.response?.data) {
    try { return JSON.stringify(err.response.data); } catch {}
    return String(err.response.data);
  }
  if (err?.message) return err.message;
  return String(err);
}

function cssOnly(text = "") {
  return String(text)
    .replace(/^```(?:css)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}
function textOnly(s = "") {
  return String(s).replace(/```[\s\S]*?```/g, "").trim();
}

/**
 * Scope enforcement: prefix all top-level selectors (excluding @rules and :root).
 * Note: pragmatic regex approach for reliability with model output.
 */
function enforceScope(inputCss = "", scope = ".comp") {
  let css = cssOnly(inputCss);
  css = css.replace(/(^|})\s*([^@}{]+?)\s*\{/g, (m, p1, selectors) => {
    const scoped = selectors
      .split(",")
      .map(s => s.trim())
      .map(sel => {
        if (!sel || sel.startsWith(scope) || sel.startsWith(":root")) return sel;
        return `${scope} ${sel}`;
      })
      .join(", ");
    return `${p1} ${scoped} {`;
  });
  return css.trim();
}

/**
 * Heuristic autofix to make the CSS parseable:
 * - remove START_CSS markers
 * - strip dangling commas
 * - drop empty rgba(...,0) shadow layers
 * - ensure ; before } and balance braces
 * - normalize common gradient typos
 */
function autofixCss(css = "") {
  let out = cssOnly(css);

  // Remove markers/comments the model sometimes emits
  out = out.replace(/\/\*+\s*START_CSS\s*\*+\//gi, "");

  // Common tokenization glitches: ", ;" or ", }"
  out = out.replace(/,\s*(;|\})/g, "$1");

  // Normalize "background: linear-gradient(to bottom" missing close
  out = out.replace(/linear-gradient\(([^)]+)\n?/gi, (m) => m.replace(/\n/g, ' '));

  // Remove empty shadow layers where alpha = 0
  out = out.replace(/(box-shadow\s*:\s*)([^;]+);/gi, (m, p, val) => {
    const cleaned = val
      .split(/\s*,\s*/)
      .filter(layer => !/rgba?\([^)]*,\s*0(?:\.0+)?\)/i.test(layer))
      .join(", ");
    return `${p}${cleaned};`;
  });

  // Ensure semicolons for last declarations in a block
  out = out.replace(/([^;\{\}\s])\s*\}/g, "$1; }");

  // Balance braces if model cut off a block
  const open = (out.match(/\{/g) || []).length;
  const close = (out.match(/\}/g) || []).length;
  if (open > close) out += "}".repeat(open - close);

  // Remove duplicate empty blocks
  out = out.replace(/\{\s*\}/g, "{}");

  return out.trim();
}

/** Replace gradient backgrounds with a solid color (when requested). */
function flattenGradients(css = "", solid = "") {
  const color = solid && /^#|rgb|hsl|var\(/i.test(solid) ? solid : null;

  // background-image: linear-gradient(...)
  let out = css.replace(/background-image\s*:\s*linear-gradient\([^;]+;\s*/gi, (m) =>
    color ? `background-color: ${color};` : m
  );

  // background: linear-gradient(...)
  out = out.replace(/background\s*:\s*linear-gradient\([^;]+;\s*/gi, (m) =>
    color ? `background-color: ${color};` : m
  );

  return out;
}

/** Minimal, readable minifier. */
function minifyCss(css = "") {
  return css
    .replace(/\s*\/\*[\s\S]*?\*\/\s*/g, "")
    .replace(/\s*([\{\}:;,])\s*/g, "$1")
    .replace(/;}/g, "}")
    .trim();
}
