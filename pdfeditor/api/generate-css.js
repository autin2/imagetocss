// /api/generate-css.js
// CSS-only, component-scoped generator with critique→fix loops, model fallback,
// and GPT-5 parameter compatibility (max_completion_tokens, no temperature).

import OpenAI from "openai";

/* ==========================
   Model choices & defaults
   ========================== */

const MODEL_CHAIN = [
  process.env.OPENAI_MODEL, // optional override
  "gpt-5",
  "gpt-5-mini",
  "gpt-4o",
  "gpt-4o-mini"
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

    // Stream-safe body parse
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
      force_solid = false,         // flatten gradients (optional)
      solid_color = "",            // color for flattening (optional)
      minify = false,              // (optional)
      debug = false                // (optional) include chosen model in response
    } = body;

    if (!image || typeof image !== "string" || !/^data:image\//i.test(image)) {
      return sendError(res, 400, "Invalid 'image'", "Expected a data URL (data:image/*;base64,...)");
    }
    if (!process.env.OPENAI_API_KEY) {
      return sendError(res, 500, "OPENAI_API_KEY not configured", "Set OPENAI_API_KEY in environment.");
    }

    const cycles = clampInt(double_checks, 1, 8);

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const { callWithModel, getUsableModel } = makeOpenAI(client);

    // Figure out which model we can actually use (and remember it)
    const usedModel = await getUsableModel();

    // ---------- DRAFT ----------
    let draft = await callWithModel("draft", {
      model: usedModel, image, palette, scope, component
    });

    draft = enforceScope(draft, scope);
    let css = draft;
    const versions = [draft];
    let lastCritique = "";

    // ---------- CRITIQUE→FIX ----------
    for (let i = 1; i <= cycles; i++) {
      lastCritique = await callWithModel("critique", {
        model: usedModel, image, css, palette, scope, component, cycle: i, total: cycles
      });

      let fixed = await callWithModel("fix", {
        model: usedModel, image, css, critique: lastCritique, palette, scope, component, cycle: i, total: cycles
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
      component,
      used_model: usedModel
    };

    if (debug) payload.debug = { model_chain: MODEL_CHAIN, default_model: DEFAULT_MODEL };

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(payload);

  } catch (err) {
    return sendError(res, 500, "Failed to generate CSS.", extractErrMsg(err), "Check server logs for stack trace.");
  }
}

/* ==========================
   OpenAI glue (GPT-5 compatible)
   ========================== */

function isGpt5(model) {
  return /^gpt-5(\b|-)/i.test(model);
}

/**
 * Build params for Chat Completions with model-specific quirks:
 * - GPT-5: use max_completion_tokens, omit temperature.
 * - Others: use max_tokens and allow temperature.
 */
function buildChatParams({ model, messages, maxDraft = 1200, maxCrit = 700, maxFix = 1400, kind }) {
  const base = { model, messages };

  if (isGpt5(model)) {
    // GPT-5 style
    if (kind === "draft") base.max_completion_tokens = maxDraft;
    else if (kind === "critique") base.max_completion_tokens = maxCrit;
    else base.max_completion_tokens = maxFix;
    // Temperature: many GPT-5 configs reject non-default; omit entirely.
  } else {
    // 4o / 4o-mini etc.
    if (kind === "draft") { base.max_tokens = maxDraft; base.temperature = 0.2; }
    else if (kind === "critique") { base.max_tokens = maxCrit; base.temperature = 0.0; }
    else { base.max_tokens = maxFix; base.temperature = 0.1; }
  }

  return base;
}

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

  const getUsableModel = async () => {
    const { model } = await tryEachModel(async (m) => {
      // Lightweight “ping”: call a tiny completion with no image to verify model exists.
      await client.chat.completions.create({
        model: m,
        messages: [{ role: "user", content: "ping" }],
        ...(isGpt5(m) ? { max_completion_tokens: 16 } : { max_tokens: 16 })
      });
      return m;
    });
    return model;
  };

  const callWithModel = async (kind, args) => {
    // We already resolved a usable model once; but args.model is passed through as that chosen model.
    const model = args.model;

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
          "- Prefix all selectors with the scope (e.g., `.comp .btn`) or use the scope root (e.g., `.comp{...}`).",
          "- No global resets. No page layout. No headers/footers/cookie banners.",
          "- If gradients are visible, use linear-gradient; if not, use a solid background-color.",
          args.palette?.length ? `Optional palette tokens: ${args.palette.join(", ")}` : "Palette: optional.",
          "Return CSS ONLY."
        ].join("\n");

      const messages = [
        { role: "system", content: sysDraft },
        {
          role: "user",
          content: [
            { type: "text", text: usr },
            { type: "image_url", image_url: { url: args.image } }
          ]
        }
      ];

      const params = buildChatParams({ model, messages, kind: "draft" });
      const r = await client.chat.completions.create(params);
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

      const messages = [
        { role: "system", content: sysCrit },
        {
          role: "user",
          content: [
            { type: "text", text: usr },
            { type: "image_url", image_url: { url: args.image } }
          ]
        }
      ];

      const params = buildChatParams({ model, messages, kind: "critique" });
      const r = await client.chat.completions.create(params);
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

      const messages = [
        { role: "system", content: sysFix },
        {
          role: "user",
          content: [
            { type: "text", text: usr },
            { type: "image_url", image_url: { url: args.image } }
          ]
        }
      ];

      const params = buildChatParams({ model, messages, kind: "fix" });
      const r = await client.chat.completions.create(params);
      return cssOnly(r?.choices?.[0]?.message?.content || args.css);
    }

    throw new Error(`Unknown call kind: ${kind}`);
  };

  return { callWithModel, getUsableModel };
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
 */
function autofixCss(css = "") {
  let out = cssOnly(css);

  // Remove markers/comments the model sometimes emits
  out = out.replace(/\/\*+\s*START_CSS\s*\*+\//gi, "");

  // Common tokenization glitches: ", ;" or ", }"
  out = out.replace(/,\s*(;|\})/g, "$1");

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

  return out.trim();
}

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

function minifyCss(css = "") {
  return css
    .replace(/\s*\/\*[\s\S]*?\*\/\s*/g, "")
    .replace(/\s*([\{\}:;,])\s*/g, "$1")
    .replace(/;}/g, "}")
    .trim();
}
