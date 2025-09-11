// /api/generate-css.js
// Component-scoped CSS generator with critique→fix loops, robust GPT-5/4o support,
// empty-output recovery, fallbacks, and CSS autofix.

import OpenAI from "openai";

/* ---------------- Models ---------------- */

const MODEL_CHAIN = [
  process.env.OPENAI_MODEL, // optional env override
  "gpt-5",
  "gpt-5-mini",
  "gpt-4o",
  "gpt-4o-mini"
].filter(Boolean);

const DEFAULT_MODEL = MODEL_CHAIN[0] || "gpt-4o-mini";

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
      force_solid = false,          // flatten gradients → solid
      solid_color = "",
      minify = false,
      debug = false
    } = body;

    if (!image || typeof image !== "string" || !/^data:image\//i.test(image)) {
      return sendError(res, 400, "Invalid 'image'", "Expected a data URL: data:image/*;base64,...");
    }
    if (!process.env.OPENAI_API_KEY) {
      return sendError(res, 500, "OPENAI_API_KEY not configured", "Set OPENAI_API_KEY in env");
    }

    const cycles = clampInt(double_checks, 1, 8);
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const { getUsableModel, callOnce } = makeOpenAI(client);

    // Resolve a usable model up front
    const usedModel = await getUsableModel();

    // ---------- DRAFT (with empty-output recovery) ----------
    let draft = await safeDraft(callOnce, { model: usedModel, image, palette, scope, component });
    draft = enforceScope(draft, scope);

    let css = draft;
    const versions = [draft];
    let lastCritique = "";

    // ---------- CRITIQUE→FIX ----------
    for (let i = 1; i <= cycles; i++) {
      lastCritique = await safeCritique(callOnce, {
        model: usedModel, image, css, palette, scope, component, cycle: i, total: cycles
      });

      let fixed = await safeFix(callOnce, {
        model: usedModel, image, css, critique: lastCritique, palette, scope, component, cycle: i, total: cycles
      });

      fixed = enforceScope(fixed, scope);
      css = fixed;
      versions.push(css);
    }

    // ---------- POST ----------
    css = cssOnly(css);
    css = autofixCss(css);
    if (!css.trim()) {
      return sendError(res, 502, "Model returned no CSS", "Empty completion after retries.", "Try a different model or smaller crop.");
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
      used_model: usedModel
    };
    if (debug) payload.debug = { model_chain: MODEL_CHAIN };

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(payload);

  } catch (err) {
    return sendError(res, 500, "Failed to generate CSS.", extractErrMsg(err), "Check server logs for stack trace.");
  }
}

/* ---------------- OpenAI glue ---------------- */

function isGpt5(model) { return /^gpt-5(\b|-)/i.test(model); }

function buildChatParams({ model, messages, kind }) {
  const base = { model, messages };
  // token budgets
  const BUDGET = { draft: 1200, critique: 700, fix: 1400 };
  const max = BUDGET[kind] || 900;

  if (isGpt5(model)) {
    base.max_completion_tokens = max; // GPT-5 expects this
    // omit temperature (many GPT-5 configs only accept default)
  } else {
    base.max_tokens = max;            // 4o/4o-mini
    base.temperature = kind === "critique" ? 0.0 : (kind === "draft" ? 0.2 : 0.1);
  }
  return base;
}

function makeOpenAI(client) {
  async function tryEachModel(run) {
    let lastErr;
    for (const model of (MODEL_CHAIN.length ? MODEL_CHAIN : [DEFAULT_MODEL])) {
      try {
        const out = await run(model);
        return { model, out };
      } catch (e) {
        lastErr = e;
        const msg = String(e?.message || "");
        const soft = e?.status === 404 || /does not exist|unknown model|restricted/i.test(msg);
        if (!soft) throw e; // real error; stop
        // else try next
      }
    }
    throw lastErr || new Error("No usable model found");
  }

  const getUsableModel = async () => {
    const { model } = await tryEachModel(async (m) => {
      // tiny ping to ensure the model/route accepts params
      await client.chat.completions.create({
        model: m,
        messages: [{ role: "user", content: "ping" }],
        ...(isGpt5(m) ? { max_completion_tokens: 16 } : { max_tokens: 16 })
      });
      return true;
    });
    return model;
  };

  const callOnce = async (kind, args) => {
    const model = args.model;

    const sys = {
      draft:
        "You are a front-end CSS engine. Output VALID vanilla CSS only (no HTML/Markdown). " +
        "You are styling a SINGLE UI COMPONENT (not a full page). " +
        "All selectors MUST be scoped under the provided SCOPE CLASS. " +
        "Do NOT target html/body/universal selectors or add resets/normalizers. " +
        "If gradients are visible, use linear-gradient; if not, prefer a solid background-color. " +
        "Return CSS ONLY.",
      critique:
        "You are a strict component QA assistant. Do NOT output CSS. " +
        "Compare the screenshot WITH the CURRENT component CSS. " +
        "Identify concrete mismatches (alignment, spacing, radius, borders, colors, size, typography, hover). " +
        "Ensure selectors remain under the provided scope. Be terse.",
      fix:
        "Return CSS only (no HTML/Markdown). Overwrite the stylesheet to resolve the critique " +
        "and better match the screenshot of the SINGLE COMPONENT. " +
        "All selectors must remain under the provided scope. No global resets."
    }[kind];

    if (kind === "draft") {
      const usr =
        [
          `SCOPE CLASS: ${args.scope}`,
          `COMPONENT TYPE (hint): ${args.component}`,
          "Task: study the screenshot region and produce CSS for ONLY that component.",
          "- Prefix all selectors with the scope (e.g., `.comp .btn`) or use the scope as root (e.g., `.comp{...}`).",
          "- No page layout. No headers/footers/cookie banners.",
          args.palette?.length ? `Optional palette tokens: ${args.palette.join(", ")}` : "Palette: optional.",
          "Return CSS ONLY."
        ].join("\n");

      const messages = [
        { role: "system", content: sys },
        {
          role: "user",
          content: [
            { type: "text", text: usr },
            { type: "image_url", image_url: { url: args.image, detail: "high" } }
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
          `SCOPE CLASS: ${args.scope}`, `COMPONENT TYPE (hint): ${args.component}`,
          "List actionable corrections with target selectors when possible.",
          "", "CURRENT CSS:", "```css", args.css, "```",
          args.palette?.length ? `Palette hint: ${args.palette.join(", ")}` : ""
        ].join("\n");

      const messages = [
        { role: "system", content: sys },
        {
          role: "user",
          content: [
            { type: "text", text: usr },
            { type: "image_url", image_url: { url: args.image, detail: "high" } }
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
          `SCOPE CLASS: ${args.scope}`, `COMPONENT TYPE (hint): ${args.component}`,
          "Rules:",
          "- Keep all selectors under the scope.",
          "- No body/html/universal selectors. No page-level structures.",
          "- Adjust alignment, spacing, borders, radius, colors, typography, hover to match the screenshot.",
          "", "CRITIQUE:", args.critique || "(none)",
          "", "CURRENT CSS:", "```css", args.css, "```",
          args.palette?.length ? `Palette hint (optional): ${args.palette.join(", ")}` : ""
        ].join("\n");

      const messages = [
        { role: "system", content: sys },
        {
          role: "user",
          content: [
            { type: "text", text: usr },
            { type: "image_url", image_url: { url: args.image, detail: "high" } }
          ]
        }
      ];
      const params = buildChatParams({ model, messages, kind: "fix" });
      const r = await client.chat.completions.create(params);
      return cssOnly(r?.choices?.[0]?.message?.content || args.css);
    }

    throw new Error(`Unknown kind: ${kind}`);
  };

  return { getUsableModel, callOnce };
}

/* ---------------- Recovery wrappers ---------------- */

/** If draft is empty, retry once (vision) then fall back to text-only prompt, then fall back model. */
async function safeDraft(callOnce, { model, image, palette, scope, component }) {
  let out = await callOnce("draft", { model, image, palette, scope, component });
  if (out && out.trim()) return out;

  // Retry same model once (vision)
  out = await callOnce("draft", { model, image, palette, scope, component });
  if (out && out.trim()) return out;

  // Fallback: 4o → 4o-mini (vision)
  for (const m of ["gpt-4o", "gpt-4o-mini"]) {
    if (m === model) continue;
    try {
      out = await callOnce("draft", { model: m, image, palette, scope, component });
      if (out && out.trim()) return out;
    } catch {}
  }

  // Last resort: text-only description request (no image)
  try {
    const textOnlyOut = await callOnce("draft", {
      model: "gpt-4o-mini",
      image: `data:image/png;base64,`, // empty, we’ll replace with text
      palette, scope, component
    });
    if (textOnlyOut && textOnlyOut.trim()) return textOnlyOut;
  } catch {}

  return ""; // let caller error out with 502
}

async function safeCritique(callOnce, args) {
  try {
    const out = await callOnce("critique", args);
    return out || "";
  } catch { return ""; }
}

async function safeFix(callOnce, args) {
  try {
    const out = await callOnce("fix", args);
    return out || args.css || "";
  } catch { return args.css || ""; }
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
  return String(text)
    .replace(/^```(?:css)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
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

/** Heuristic CSS repair: remove markers, fix commas/semicolons, drop zero-alpha shadow layers, balance braces */
function autofixCss(css = "") {
  let out = cssOnly(css);

  // Remove markers like /* START_CSS */
  out = out.replace(/\/\*+\s*START_CSS\s*\*+\//gi, "");

  // Fix dangling commas before ; or }
  out = out.replace(/,\s*(;|\})/g, "$1");

  // Drop rgba(...,0) shadow layers
  out = out.replace(/(box-shadow\s*:\s*)([^;]+);/gi, (m, p, val) => {
    const cleaned = val
      .split(/\s*,\s*/)
      .filter(layer => !/rgba?\([^)]*,\s*0(?:\.0+)?\)/i.test(layer))
      .join(", ");
    return `${p}${cleaned};`;
  });

  // Ensure each block's last decl ends with a semicolon
  out = out.replace(/([^;\{\}\s])\s*\}/g, "$1; }");

  // Balance braces
  const open = (out.match(/\{/g) || []).length;
  const close = (out.match(/\}/g) || []).length;
  if (open > close) out += "}".repeat(open - close);

  return out.trim();
}

/** Replace gradient backgrounds with a solid color (optional) */
function flattenGradients(css = "", solid = "") {
  const color = solid && /^#|rgb|hsl|var\(/i.test(solid) ? solid : null;
  let out = css.replace(/background-image\s*:\s*linear-gradient\([^;]+;/gi, m => color ? `background-color: ${color};` : m);
  out = out.replace(/background\s*:\s*linear-gradient\([^;]+;/gi, m => color ? `background-color: ${color};` : m);
  return out;
}

/** Simple readable minifier */
function minifyCss(css = "") {
  return css
    .replace(/\s*\/\*[\s\S]*?\*\/\s*/g, "")
    .replace(/\s*([\{\}:;,])\s*/g, "$1")
    .replace(/;}/g, "}")
    .trim();
}
