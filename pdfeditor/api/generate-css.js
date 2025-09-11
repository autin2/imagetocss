// /api/generate-css.js
// Component-scoped CSS generator with critique→fix loops, shadow emphasis,
// GPT-5/4o compatibility, and a "shadow ensure" recovery pass.

import OpenAI from "openai";

/* ---------- models ---------- */
const MODEL_CHAIN = [
  process.env.OPENAI_MODEL,
  "gpt-5",
  "gpt-5-mini",
  "gpt-4o",
  "gpt-4o-mini"
].filter(Boolean);
const DEFAULT_MODEL = MODEL_CHAIN[0] || "gpt-4o-mini";

/* ---------- handler ---------- */
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
    catch (e) { return sendError(res, 400, "Bad JSON", e?.message, "Send application/json"); }

    const {
      image,
      palette = [],
      double_checks = 1,              // 1–8
      scope = ".comp",
      component = "component",
      prefer_shadows = true,          // <— NEW: try hard to include drop shadows if visible
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
    const { getUsableModel, callOnce } = makeOpenAI(client);

    const usedModel = await getUsableModel();

    // ----- draft -----
    let draft = await callOnce("draft", { model: usedModel, image, palette, scope, component, prefer_shadows });
    draft = enforceScope(draft, scope);

    let css = draft;
    const versions = [draft];
    let lastCritique = "";

    // ----- critique→fix -----
    for (let i = 1; i <= cycles; i++) {
      lastCritique = await callOnce("critique", {
        model: usedModel, image, css, palette, scope, component, cycle: i, total: cycles, prefer_shadows
      });

      let fixed = await callOnce("fix", {
        model: usedModel, image, css, critique: lastCritique, palette, scope, component, cycle: i, total: cycles, prefer_shadows
      });

      fixed = enforceScope(fixed, scope);
      css = fixed;
      versions.push(css);
    }

    // ----- post / shadow ensure -----
    css = cssOnly(css);
    css = autofixCss(css);

    if (prefer_shadows && !/\bbox-shadow\b/i.test(css)) {
      css = await ensureDropShadow(callOnce, { model: usedModel, image, css, scope, component });
      css = cssOnly(autofixCss(css));
    }

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
      used_model: usedModel
    };
    if (debug) payload.debug = { model_chain: MODEL_CHAIN };

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(payload);

  } catch (err) {
    return sendError(res, 500, "Failed to generate CSS.", extractErrMsg(err));
  }
}

/* ---------- OpenAI glue ---------- */
function isGpt5(m){ return /^gpt-5(\b|-)/i.test(m); }
function buildChatParams({ model, messages, kind }) {
  const base = { model, messages };
  const BUDGET = { draft: 1200, critique: 700, fix: 1400 };
  const max = BUDGET[kind] || 900;
  if (isGpt5(model)) base.max_completion_tokens = max; else { base.max_tokens = max; base.temperature = kind === "critique" ? 0.0 : (kind === "draft" ? 0.2 : 0.1); }
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
        if (!soft) throw e;
      }
    }
    throw lastErr || new Error("No usable model found");
  }

  const getUsableModel = async () => {
    const { model } = await tryEachModel(async (m) => {
      await client.chat.completions.create({
        model: m,
        messages: [{ role: "user", content: "ping" }],
        ...(isGpt5(m) ? { max_completion_tokens: 16 } : { max_tokens: 16 })
      });
    });
    return model;
  };

  const callOnce = async (kind, args) => {
    const model = args.model;

    const sysDraft =
      "You are a front-end CSS engine. Output VALID vanilla CSS only (no HTML/Markdown). " +
      "You are styling ONE UI COMPONENT (not a full page). " +
      "All selectors MUST be scoped under the provided SCOPE CLASS. " +
      "Do NOT target html/body/universal selectors or add resets/normalizers. " +
      "Shadows & highlights: If a cast outer drop shadow is visible below/right of the component, " +
      "include a matching box-shadow layer (offset, blur, and color). If none is visible, do not invent one. " +
      "Also preserve any inset gloss/highlight if present via an extra layer or ::after overlay. " +
      "Return CSS ONLY.";

    const sysCrit =
      "You are a strict component QA assistant. Do NOT output CSS. " +
      "Compare the screenshot WITH the CURRENT component CSS. " +
      "Identify concrete mismatches in: alignment, spacing, radius, borders, COLORS, TYPOGRAPHY, GRADIENTS, and " +
      "especially OUTER CAST SHADOWS and INSET HIGHLIGHTS. " +
      "Note exact shadow direction (e.g., down/right), offset/blur, and whether a hard base shadow (0 blur) exists. " +
      "Ensure selectors remain under the provided scope. Be terse.";

    const sysFix =
      "Return CSS only (no HTML/Markdown). Overwrite the stylesheet to resolve the critique and match the screenshot. " +
      "All selectors must remain under the provided scope. Include outer box-shadow and inset highlights if visible.";

    if (kind === "draft") {
      const usr =
        [
          `SCOPE CLASS: ${args.scope}`,
          `COMPONENT TYPE (hint): ${args.component}`,
          "Study the screenshot region and produce CSS for ONLY that component.",
          "- Use linear-gradient only if a gradient is visible; otherwise use a solid background-color.",
          args.palette?.length ? `Optional palette tokens: ${args.palette.join(", ")}` : "Palette: optional.",
          "Return CSS ONLY."
        ].join("\n");

      const messages = [
        { role: "system", content: sysDraft },
        { role: "user",
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
          "List actionable corrections with target selectors when possible. " +
          "Call out any missing outer box-shadow and its likely offset/blur/color.",
          "", "CURRENT CSS:", "```css", args.css, "```",
          args.palette?.length ? `Palette hint: ${args.palette.join(", ")}` : ""
        ].join("\n");

      const messages = [
        { role: "system", content: sysCrit },
        { role: "user",
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
          "- No body/html/universal selectors. No page-level layout.",
          "- Adjust borders, radius, colors, gradients, typography, and shadows to match the screenshot.",
          "", "CRITIQUE:", args.critique || "(none)",
          "", "CURRENT CSS:", "```css", args.css, "```",
          args.palette?.length ? `Palette hint (optional): ${args.palette.join(", ")}` : ""
        ].join("\n");

      const messages = [
        { role: "system", content: sysFix },
        { role: "user",
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

/* ---------- shadow ensure ---------- */
async function ensureDropShadow(callOnce, { model, image, css, scope, component }) {
  // if already present, keep
  if (/\bbox-shadow\b/i.test(css)) return css;

  const critique = "The screenshot shows a visible cast drop shadow below and slightly to the right of the component. " +
                   "Add an outer box-shadow layer (down/right offset, moderate blur) and retain any inset highlight.";
  const updated = await callOnce("fix", {
    model,
    image,
    css,
    critique,
    palette: [],
    scope,
    component,
    cycle: 0,
    total: 0,
    prefer_shadows: true
  });

  return updated || css;
}

/* ---------- helpers & CSS post ---------- */
function clampInt(v,min,max){const n=Number(v);if(Number.isNaN(n))return min;return Math.max(min,Math.min(max,Math.floor(n)));}

function sendError(res, status, error, details, hint) {
  const payload = { error: String(error || "Unknown") };
  if (details) payload.details = String(details);
  if (hint) payload.hint = String(hint);
  res.status(status).json(payload);
}
function extractErrMsg(err){ if (err?.response?.data) { try { return JSON.stringify(err.response.data);} catch{} return String(err.response.data);} if (err?.message) return err.message; return String(err); }

function cssOnly(s=""){ return String(s).replace(/^```(?:css)?\s*/i,"").replace(/```$/i,"").trim(); }
function textOnly(s=""){ return String(s).replace(/```[\s\S]*?```/g,"").trim(); }

function enforceScope(css="", scope=".comp"){
  let out = cssOnly(css);
  out = out.replace(/(^|})\s*([^@}{]+?)\s*\{/g,(m,p1,selectors)=>{
    const scoped = selectors.split(",").map(s=>s.trim()).map(sel=>{
      if(!sel || sel.startsWith(scope) || sel.startsWith(":root")) return sel;
      return `${scope} ${sel}`;
    }).join(", ");
    return `${p1} ${scoped} {`;
  });
  return out.trim();
}

function autofixCss(css=""){
  let out = cssOnly(css);
  out = out.replace(/\/\*+\s*START_CSS\s*\*+\//gi,"");
  out = out.replace(/,\s*(;|\})/g,"$1");
  out = out.replace(/(box-shadow\s*:\s*)([^;]+);/gi,(m,p,val)=>{
    const cleaned = val.split(/\s*,\s*/).filter(layer=>!/rgba?\([^)]*,\s*0(?:\.0+)?\)/i.test(layer)).join(", ");
    return `${p}${cleaned};`;
  });
  out = out.replace(/([^;\{\}\s])\s*\}/g,"$1; }");
  const open=(out.match(/\{/g)||[]).length, close=(out.match(/\}/g)||[]).length;
  if(open>close) out += "}".repeat(open-close);
  return out.trim();
}
function flattenGradients(css="", solid=""){
  const color = solid && /^#|rgb|hsl|var\(/i.test(solid) ? solid : null;
  let out = css.replace(/background-image\s*:\s*linear-gradient\([^;]+;/gi, m => color ? `background-color: ${color};` : m);
  out = out.replace(/background\s*:\s*linear-gradient\([^;]+;/gi, m => color ? `background-color: ${color};` : m);
  return out;
}
function minifyCss(css=""){
  return css.replace(/\s*\/\*[\s\S]*?\*\/\s*/g,"").replace(/\s*([\{\}:;,])\s*/g,"$1").replace(/;}/g,"}").trim();
}
