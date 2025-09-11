// /api/generate-css.js
// Component-scoped CSS generator with critique→fix loops, robust GPT-5/4o support,
// empty-output recovery (vision fallback + text-only), and CSS autofix.

import OpenAI from "openai";

/* ---------------- Models ---------------- */
const MODEL_CHAIN = [
  process.env.OPENAI_MODEL, // optional override
  "gpt-5",                  // if your project has access; may not support vision
  "gpt-5-mini",             // same caveat
  "gpt-4o",
  "gpt-4o-mini"
].filter(Boolean);

const DEFAULT_MODEL = MODEL_CHAIN[0] || "gpt-4o-mini";

/* Heuristic: which models support image_url reliably via Chat Completions */
function supportsVision(model) {
  return /gpt-4o(-mini)?$/i.test(model);
}

/* ---------------- HTTP handler ---------------- */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed", details: "Use POST /api/generate-css" });
    }

    let raw = "";
    for await (const chunk of req) raw += chunk;

    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; }
    catch (e) { return sendError(res, 400, "Bad JSON", e?.message, "Send Content-Type: application/json"); }

    const {
      image,
      palette = [],
      double_checks = 1,            // 1–8
      scope = ".comp",
      component = "component",
      force_solid = false,
      solid_color = "",
      minify = false,
      debug = false
    } = body;

    if (!image || typeof image !== "string" || !/^data:image\//i.test(image)) {
      return sendError(res, 400, "Invalid 'image'", "Expected data URL: data:image/*;base64,...");
    }
    if (!process.env.OPENAI_API_KEY) {
      return sendError(res, 500, "OPENAI_API_KEY not configured");
    }

    const cycles = clampInt(double_checks, 1, 8);
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const { resolveModel, callOnce } = makeOpenAI(client);

    // Resolve a usable model (for text). Vision may still be switched per-call.
    const baseModel = await resolveModel();

    // ---------- DRAFT (with robust fallbacks) ----------
    let draft = await safeDraft({
      baseModel, image, palette, scope, component, callOnce
    });
    draft = enforceScope(draft, scope);

    let css = draft;
    const versions = [draft];
    let lastCritique = "";

    // ---------- CRITIQUE→FIX ----------
    for (let i = 1; i <= cycles; i++) {
      lastCritique = await safeCritique({
        baseModel, image, css, palette, scope, component, cycle: i, total: cycles, callOnce
      });

      let fixed = await safeFix({
        baseModel, image, css, critique: lastCritique, palette, scope, component, cycle: i, total: cycles, callOnce
      });

      fixed = enforceScope(fixed, scope);
      css = fixed;
      versions.push(css);
    }

    // ---------- POST ----------
    css = cssOnly(css);
    css = autofixCss(css);
    if (!css.trim()) {
      return sendError(res, 502, "Model returned no CSS", "Empty completion after retries.");
    }

    if (force_solid) css = flattenGradients(css, solid_color);
    if (minify) css = minifyCss(css);

    const payload = {
      draft,
      css,
      versions,
      passes: 1 + cycles * 2,
      palette,
      notes: lastCritique,
      scope,
      component,
      used_model: baseModel
    };
    if (debug) payload.debug = { model_chain: MODEL_CHAIN, vision_supported: supportsVision(baseModel) };

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(payload);

  } catch (err) {
    return sendError(res, 500, "Failed to generate CSS.", extractErrMsg(err));
  }
}

/* ---------------- OpenAI glue ---------------- */

function isGpt5(m){ return /^gpt-5(\b|-)/i.test(m); }

function buildChatParams({ model, messages, kind }) {
  const base = { model, messages };
  const BUDGET = { draft: 1200, critique: 700, fix: 1400 };
  const max = BUDGET[kind] || 900;

  if (isGpt5(model)) {
    base.max_completion_tokens = max;   // GPT-5 style
    // omit temperature (some GPT-5 configs only accept default)
  } else {
    base.max_tokens = max;              // 4o / 4o-mini
    base.temperature = kind === "critique" ? 0.0 : (kind === "draft" ? 0.2 : 0.1);
  }
  return base;
}

function makeOpenAI(client) {
  async function tryEachModel(run) {
    let lastErr;
    for (const model of (MODEL_CHAIN.length ? MODEL_CHAIN : [DEFAULT_MODEL])) {
      try { await run(model); return { model }; }
      catch (e) {
        lastErr = e;
        const msg = String(e?.message || "");
        const soft = e?.status === 404 || /does not exist|unknown model|restricted/i.test(msg);
        if (!soft) throw e; // hard error; stop
      }
    }
    throw lastErr || new Error("No usable model found");
  }

  const resolveModel = async () => {
    const { model } = await tryEachModel(async (m) => {
      // tiny text ping; if this fails, model is unusable
      await client.chat.completions.create({
        model: m,
        messages: [{ role: "user", content: "ping" }],
        ...(isGpt5(m) ? { max_completion_tokens: 16 } : { max_tokens: 16 })
      });
    });
    return model;
  };

  const callOnce = async (kind, args) => {
    // If the chosen model likely doesn't support vision, switch to a vision model for image calls.
    let modelForThisCall = args.model;
    const usingImage = !!args.image && !args.no_image;
    if (usingImage && !supportsVision(modelForThisCall)) {
      modelForThisCall = "gpt-4o"; // hard vision fallback
    }

    const sys = {
      draft:
        "You are a front-end CSS engine. Output VALID vanilla CSS only (no HTML/Markdown). " +
        "You are styling ONE UI COMPONENT (not a full page). " +
        "All selectors MUST be scoped under the provided SCOPE CLASS. " +
        "Do NOT target html/body/universal selectors or add resets/normalizers. " +
        "If gradients are visible, use linear-gradient; if not, prefer a solid background-color. " +
        "Return CSS ONLY.",
      critique:
        "You are a strict component QA assistant. Do NOT output CSS. " +
        "Compare the screenshot WITH the CURRENT component CSS. " +
        "Identify concrete mismatches (alignment, spacing, radius, borders, colors, size, typography, shadows/gradients). " +
        "Ensure selectors remain under the provided scope. Be terse.",
      fix:
        "Return CSS only (no HTML/Markdown). Overwrite the stylesheet to resolve the critique " +
        "and better match the screenshot of the SINGLE COMPONENT. " +
        "All selectors must remain under the provided scope. No global resets."
    }[kind];

    // Build messages (image + text OR text-only)
    const userTextLines = [
      `SCOPE CLASS: ${args.scope}`,
      `COMPONENT TYPE (hint): ${args.component}`
    ];

    if (kind === "draft") {
      userTextLines.push(
        usingImage
          ? "Task: study the screenshot region and produce CSS for ONLY that component."
          : "No screenshot available. Produce reasonable CSS for the component using the hint and palette."
      );
      userTextLines.push(
        "- Prefix selectors with the scope (or use the scope as root).",
        "- No page layout or resets.",
        args.palette?.length ? `Optional palette tokens: ${args.palette.join(", ")}` : "Palette: optional.",
        "Return CSS ONLY."
      );
    } else if (kind === "critique") {
      userTextLines.push(
        `Critique ${args.cycle}/${args.total}. List actionable corrections with target selectors where possible.`,
        "", "CURRENT CSS:", "```css", args.css, "```",
        args.palette?.length ? `Palette hint: ${args.palette.join(", ")}` : ""
      );
    } else if (kind === "fix") {
      userTextLines.push(
        `Fix ${args.cycle}/${args.total} for the component.`,
        "Rules:",
        "- Keep all selectors under the scope.",
        "- No body/html/universal selectors.",
        "- Adjust borders, radius, colors, gradients, typography, and shadows to match the screenshot.",
        "", "CRITIQUE:", args.critique || "(none)",
        "", "CURRENT CSS:", "```css", args.css, "```",
        args.palette?.length ? `Palette hint (optional): ${args.palette.join(", ")}` : ""
      );
    }

    const userPart = { type: "text", text: userTextLines.join("\n") };

    const messages = usingImage
      ? [
          { role: "system", content: sys },
          { role: "user", content: [userPart, { type: "image_url", image_url: { url: args.image, detail: "high" } }] }
        ]
      : [
          { role: "system", content: sys },
          { role: "user", content: [userPart] }
        ];

    const params = buildChatParams({ model: modelForThisCall, messages, kind });
    const r = await client.chat.completions.create(params);

    return (kind === "critique")
      ? textOnly(r?.choices?.[0]?.message?.content || "")
      : cssOnly(r?.choices?.[0]?.message?.content || (kind === "fix" ? args.css : ""));
  };

  return { resolveModel, callOnce };
}

/* ---------------- Recovery wrappers ---------------- */

async function safeDraft({ baseModel, image, palette, scope, component, callOnce }) {
  // 1) try with whatever model they chose (auto-vision fallback inside callOnce)
  let out = await callOnce("draft", { model: baseModel, image, palette, scope, component });
  if (out && out.trim()) return out;

  // 2) retry once (same path)
  out = await callOnce("draft", { model: baseModel, image, palette, scope, component });
  if (out && out.trim()) return out;

  // 3) explicit vision fallbacks
  for (const m of ["gpt-4o", "gpt-4o-mini"]) {
    try {
      out = await callOnce("draft", { model: m, image, palette, scope, component });
      if (out && out.trim()) return out;
    } catch {}
  }

  // 4) text-only fallback (no image block at all)
  try {
    out = await callOnce("draft", { model: "gpt-4o-mini", no_image: true, image: null, palette, scope, component });
    if (out && out.trim()) return out;
  } catch {}

  return "";
}

async function safeCritique(args) {
  try { return await args.callOnce("critique", args); }
  catch { return ""; }
}

async function safeFix(args) {
  try { return await args.callOnce("fix", args); }
  catch { return args.css || ""; }
}

/* ---------------- Helpers & post-processing ---------------- */

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
  return String(text).replace(/^```(?:css)?\s*/i, "").replace(/```$/i, "").trim();
}
function textOnly(s = "") {
  return String(s).replace(/```[\s\S]*?```/g, "").trim();
}

/** Prefix non-@, non-:root top-level selectors with scope */
function enforceScope(inputCss = "", scope = ".comp") {
  let css = cssOnly(inputCss);
  css = css.replace(/(^|})\s*([^@}{]+?)\s*\{/g, (m, p1, selectors) => {
    const scoped = selectors
      .split(",")
      .map(s => s.trim())
      .map(sel => (!sel || sel.startsWith(scope) || sel.startsWith(":root")) ? sel : `${scope} ${sel}`)
      .join(", ");
    return `${p1} ${scoped} {`;
  });
  return css.trim();
}

/** Heuristic CSS repair */
function autofixCss(css = "") {
  let out = cssOnly(css);
  out = out.replace(/\/\*+\s*START_CSS\s*\*+\//gi, "");  // strip markers
  out = out.replace(/,\s*(;|\})/g, "$1");                // fix dangling commas
  // remove zero-alpha shadow layers
  out = out.replace(/(box-shadow\s*:\s*)([^;]+);/gi, (m, p, val) => {
    const cleaned = val.split(/\s*,\s*/).filter(layer => !/rgba?\([^)]*,\s*0(?:\.0+)?\)/i.test(layer)).join(", ");
    return `${p}${cleaned};`;
  });
  out = out.replace(/([^;\{\}\s])\s*\}/g, "$1; }");      // ensure semicolons
  const open = (out.match(/\{/g) || []).length;
  const close = (out.match(/\}/g) || []).length;
  if (open > close) out += "}".repeat(open - close);     // balance braces
  return out.trim();
}

function flattenGradients(css = "", solid = "") {
  const color = solid && /^#|rgb|hsl|var\(/i.test(solid) ? solid : null;
  let out = css.replace(/background-image\s*:\s*linear-gradient\([^;]+;/gi, m => color ? `background-color: ${color};` : m);
  out = out.replace(/background\s*:\s*linear-gradient\([^;]+;/gi, m => color ? `background-color: ${color};` : m);
  return out;
}

function minifyCss(css = "") {
  return css
    .replace(/\s*\/\*[\s\S]*?\*\/\s*/g, "")
    .replace(/\s*([\{\}:;,])\s*/g, "$1")
    .replace(/;}/g, "}")
    .trim();
}
