// /api/generate-css.js
// Component-scoped CSS generator with critique→fix loops and robust HTML builder.
// Improvements:
// - Vision “hints” now extracts segmented-control tokens from the image (labels, dropdowns, link-like items, dot icon).
// - HTML generator renders a single-pill .chip with inline .seg items, .divider bars, optional .dot,
//   and adds caret markers when segments look like dropdowns.
// - Still returns plain CSS (scoped), but HTML now better reflects segmented controls.
//
// ENV:
//   OPENAI_API_KEY (required)
//   OPENAI_MODEL   (optional) one of: gpt-5, gpt-5-mini, gpt-4o, gpt-4o-mini
//
// Response JSON:
//   { draft, css, html, versions, passes, palette, notes, scope, component, used_model }

import OpenAI from "openai";

/* ---------------- Models ---------------- */
const MODEL_CHAIN = [
  process.env.OPENAI_MODEL, // optional override
  "gpt-5",
  "gpt-5-mini",
  "gpt-4o",
  "gpt-4o-mini"
].filter(Boolean);

const DEFAULT_MODEL = MODEL_CHAIN[0] || "gpt-4o-mini";

function supportsVision(model) { return /gpt-4o(?:-mini)?$/i.test(model); }
function isGpt5(m){ return /^gpt-5(\b|-)/i.test(m); }

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
      force_solid = false,          // optional: replace gradients with solid
      solid_color = "",             // optional solid color
      minify = false,               // optional minify result
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

    const baseModel = await resolveModel();

    // ---------- DRAFT ----------
    let draft = await safeDraft({ baseModel, image, palette, scope, component, callOnce });
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
    if (!css.trim()) return sendError(res, 502, "Model returned no CSS", "Empty completion after retries.");

    if (force_solid) css = flattenGradients(css, solid_color);
    if (minify) css = minifyCss(css);

    // ---------- VISION HINTS (extract visible strings + segmented tokens) ----------
    const hints = await extractHints({ baseModel, image, scope, component, callOnce });

    // ---------- HTML (vision + CSS-coverage + segmented control support) ----------
    let html = await suggestHtml({ baseModel, image, css, scope, component, hints, callOnce });
    if (!html || !html.trim()) {
      // Build from hints (segmented control) if possible, else fallback from CSS
      html = buildHtmlFromHints(hints, scope) || buildHtmlFromCss(css, scope) || ensureScopedHtml(`<div>${fallbackInner(component)}</div>`, scope);
    }
    html = ensureScopedHtml(htmlOnly(html), scope);
    html = ensureHtmlCoversCss(html, css, hints, scope); // make sure input/button exist if styled
    html = applyTextHints(html, hints);                  // inject “Subscribe”, placeholders, etc.

    const payload = {
      draft,
      css,
      html,
      versions,
      passes: 1 + cycles * 2,
      palette,
      notes: lastCritique,
      scope,
      component,
      used_model: baseModel,
      ...(debug ? { debug: { model_chain: MODEL_CHAIN, vision_supported: supportsVision(baseModel), hints } } : {})
    };

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(payload);

  } catch (err) {
    return sendError(res, 500, "Failed to generate CSS.", extractErrMsg(err));
  }
}

/* ---------------- OpenAI glue ---------------- */

function buildChatParams({ model, messages, kind }) {
  const base = { model, messages };
  const BUDGET = { draft: 1400, critique: 800, fix: 1600, html: 800, hints: 380 };
  const max = BUDGET[kind] || 900;

  if (isGpt5(model)) {
    base.max_completion_tokens = max;     // GPT-5 family
  } else {
    base.max_tokens = max;                // 4o / 4o-mini
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
        if (!soft) throw e;
      }
    }
    throw lastErr || new Error("No usable model found");
  }

  const resolveModel = async () => {
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
    let modelForThisCall = args.model;
    const usingImage = !!args.image && !args.no_image;
    if (usingImage && !supportsVision(modelForThisCall)) modelForThisCall = "gpt-4o";

    const sys = {
      draft:
        "You are a front-end CSS engine. Output VALID vanilla CSS only (no HTML/Markdown). " +
        "You are styling ONE UI COMPONENT (not a full page). " +
        "All selectors MUST be scoped under the provided SCOPE CLASS. " +
        "Do NOT target html/body/universal selectors or add resets/normalizers. " +
        "If the screenshot shows a SEGMENTED PILL/CHIP (one rounded container with multiple inline items separated by thin dividers), " +
        "write rules for the container (e.g., `.chip`), segment items (e.g., `.seg`), divider lines (`.divider`), " +
        "and small dot/chevron decorations when present. " +
        "If no gradient is visible, prefer a solid background-color. Return CSS ONLY.",
      critique:
        "You are a strict component QA assistant. Do NOT output CSS. Compare screenshot vs CURRENT CSS. " +
        "Call out mismatches in: container shape (single rounded pill), inline segment spacing, divider visibility, dot/chevron, " +
        "font size/weight, colors, borders, radius, shadows, and whether items are links or buttons. Be terse.",
      fix:
        "Return CSS only (no HTML/Markdown). Overwrite the stylesheet to resolve the critique and better match the screenshot. " +
        "Keep all selectors under the scope. Include container `.chip`, `.seg`, `.divider`, `.dot`, caret pseudo-elements if needed.",
      html:
        "Return HTML ONLY (no code fences). Build a minimal DOM that demonstrates the CSS. " +
        "If the screenshot shows a segmented pill, render a single `.chip` container with inline `.seg` items separated by `.divider` spans. " +
        "Include a small `.dot` element before 'Compare' if visible and a caret (▼) for dropdown-like items. " +
        "Use the provided HINTS to set button/link text and placeholders.",
      hints:
        "Return JSON ONLY that describes visible UI tokens for a SINGLE component. " +
        "{ \"segments\": [ {\"text\": string, \"role\": \"label|dropdown|link|toggle|value|unknown\", \"caret\": boolean, \"dot\": boolean } , ... ], " +
        "\"has_input\": boolean, \"input_type\": \"text|email|search|password|other|unknown\", \"input_placeholder\": string, " +
        "\"has_button\": boolean, \"button_text\": string }. " +
        "If there is a segmented pill, fill `segments` in visual order using concise text (e.g., 'Date range', 'Last 7 days', 'Daily', 'Compare', 'Previous period')."
    }[kind];

    // messages
    const baseLines = [
      `SCOPE CLASS: ${args.scope}`,
      `COMPONENT TYPE (hint): ${args.component}`
    ];

    let messages;
    if (kind === "draft") {
      const usr = [
        ...baseLines,
        usingImage
          ? "Study the screenshot and produce CSS for ONLY that component."
          : "No screenshot available; produce reasonable CSS for the component using the hint/palette.",
        "- Prefix selectors with the scope or use the scope as root.",
        "- No resets or page layout.",
        args.palette?.length ? `Optional palette tokens: ${args.palette.join(", ")}` : "Palette: optional.",
        "Return CSS ONLY."
      ].join("\n");
      messages = usingImage
        ? [{ role: "system", content: sys }, { role: "user", content: [{ type: "text", text: usr }, { type: "image_url", image_url: { url: args.image, detail: "high" } }] }]
        : [{ role: "system", content: sys }, { role: "user", content: [{ type: "text", text: usr }] }];
    }
    else if (kind === "critique") {
      const usr = [
        ...baseLines,
        `Critique ${args.cycle}/${args.total}.`,
        "", "CURRENT CSS:", "```css", args.css, "```",
        args.palette?.length ? `Palette hint: ${args.palette.join(", ")}` : ""
      ].join("\n");
      messages = usingImage
        ? [{ role: "system", content: sys }, { role: "user", content: [{ type: "text", text: usr }, { type: "image_url", image_url: { url: args.image, detail: "high" } }] }]
        : [{ role: "system", content: sys }, { role: "user", content: [{ type: "text", text: usr }] }];
    }
    else if (kind === "fix") {
      const usr = [
        ...baseLines,
        `Fix ${args.cycle}/${args.total}.`,
        "Rules:",
        "- Keep all selectors under the scope.",
        "- Include container/segments/dividers if screenshot shows a segmented pill.",
        "", "CRITIQUE:", args.critique || "(none)",
        "", "CURRENT CSS:", "```css", args.css, "```",
        args.palette?.length ? `Palette hint: ${args.palette.join(", ")}` : ""
      ].join("\n");
      messages = usingImage
        ? [{ role: "system", content: sys }, { role: "user", content: [{ type: "text", text: usr }, { type: "image_url", image_url: { url: args.image, detail: "high" } }] }]
        : [{ role: "system", content: sys }, { role: "user", content: [{ type: "text", text: usr }] }];
    }
    else if (kind === "html") {
      const usr = [
        ...baseLines,
        "Generate minimal HTML that picks up ALL styles in the CSS. Root must use the scope class.",
        "If you detect a segmented pill, use:",
        "  <div class=\"chip\">",
        "    <span class=\"seg label\">Date range</span><span class=\"divider\"></span>",
        "    <button class=\"seg value has-caret\">Last 7 days</button><span class=\"divider\"></span>",
        "    <button class=\"seg value has-caret\">Daily</button>",
        "  </div>",
        "  <div class=\"chip\">",
        "    <span class=\"seg dot\" aria-hidden=\"true\"></span>",
        "    <button class=\"seg value\">Compare</button><span class=\"divider\"></span>",
        "    <a class=\"seg link has-caret\" href=\"#\">Previous period</a>",
        "  </div>",
        "Use HINTS below to select exact text.",
        "", "CSS:", "```css", args.css, "```",
        args.hints ? `\nHINTS JSON: ${JSON.stringify(args.hints)}` : ""
      ].join("\n");
      messages = [
        { role: "system", content: sys },
        { role: "user", content: [{ type: "text", text: usr }, ...(args.image && !args.no_image ? [{ type: "image_url", image_url: { url: args.image, detail: "high" } }] : [])] }
      ];
    }
    else if (kind === "hints") {
      const usr = [
        ...baseLines,
        "Extract UI strings/tokens from this screenshot.",
        "Return JSON ONLY as specified. No code fences."
      ].join("\n");
      messages = [
        { role: "system", content: sys },
        { role: "user", content: [{ type: "text", text: usr }, { type: "image_url", image_url: { url: args.image, detail: "high" } }] }
      ];
    }
    else throw new Error(`Unknown kind: ${kind}`);

    const params = buildChatParams({ model: modelForThisCall, messages, kind });
    const r = await client.chat.completions.create(params);

    if (kind === "critique") return textOnly(r?.choices?.[0]?.message?.content || "");
    if (kind === "html")     return htmlOnly(r?.choices?.[0]?.message?.content || "");
    if (kind === "hints")    return jsonOnly(r?.choices?.[0]?.message?.content || "{}");
    // draft/fix
    return cssOnly(r?.choices?.[0]?.message?.content || (kind === "fix" ? args.css : ""));
  };

  return { resolveModel, callOnce };
}

/* ---------------- Recovery wrappers ---------------- */

async function safeDraft({ baseModel, image, palette, scope, component, callOnce }) {
  let out = await callOnce("draft", { model: baseModel, image, palette, scope, component });
  if (out && out.trim()) return out;
  out = await callOnce("draft", { model: baseModel, image, palette, scope, component });
  if (out && out.trim()) return out;
  for (const m of ["gpt-4o", "gpt-4o-mini"]) {
    try { out = await callOnce("draft", { model: m, image, palette, scope, component }); if (out && out.trim()) return out; } catch {}
  }
  try { out = await callOnce("draft", { model: "gpt-4o-mini", no_image: true, image: null, palette, scope, component }); if (out && out.trim()) return out; } catch {}
  return "";
}

async function safeCritique(args) { try { return await args.callOnce("critique", args); } catch { return ""; } }
async function safeFix(args) { try { return await args.callOnce("fix", args); } catch { return args.css || ""; } }

/* Extract tokens/labels from the screenshot */
async function extractHints({ baseModel, image, scope, component, callOnce }) {
  try {
    const json = await callOnce("hints", { model: baseModel, image, scope, component });
    // normalize
    const segments = Array.isArray(json?.segments) ? json.segments.map(s => ({
      text: String(s?.text || "").trim(),
      role: String(s?.role || "unknown").toLowerCase(),
      caret: !!s?.caret,
      dot: !!s?.dot
    })).filter(s => s.text) : [];
    return {
      segments,
      has_input: !!json?.has_input,
      input_type: String(json?.input_type || "").toLowerCase(),
      input_placeholder: typeof json?.input_placeholder === "string" ? json.input_placeholder : "",
      has_button: !!json?.has_button,
      button_text: typeof json?.button_text === "string" ? json.button_text : ""
    };
  } catch {
    return { segments: [], has_input: false, input_type: "", input_placeholder: "", has_button: false, button_text: "" };
  }
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

function cssOnly(text = "") { return String(text).replace(/^```(?:css)?\s*/i, "").replace(/```$/i, "").trim(); }
function textOnly(s = "") { return String(s).replace(/```[\s\S]*?```/g, "").trim(); }
function htmlOnly(s = "") { return String(s).replace(/^```(?:html)?\s*/i, "").replace(/```$/i, "").trim(); }
function jsonOnly(s = "") {
  const raw = String(s || "");
  try { return JSON.parse(raw); } catch {}
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return {};
}

/** Scope top-level selectors (not @rules or :root) */
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
  out = out.replace(/\/\*+\s*START_CSS\s*\*+\//gi, "");
  out = out.replace(/,\s*(;|\})/g, "$1"); // trailing commas
  out = out.replace(/(box-shadow\s*:\s*)([^;]+);/gi, (m, p, val) => {
    const cleaned = val.split(/\s*,\s*/).filter(layer => !/rgba?\([^)]*,\s*0(?:\.0+)?\)/i.test(layer)).join(", ");
    return `${p}${cleaned};`;
  });
  out = out.replace(/([^;\{\}\s])\s*\}/g, "$1; }");
  const open = (out.match(/\{/g) || []).length;
  const close = (out.match(/\}/g) || []).length;
  if (open > close) out += "}".repeat(open - close);
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

/* Build HTML purely from CSS when hints are missing */
function buildHtmlFromCss(css, scope) {
  const className = getScopeClass(scope);
  const need = {
    inputGeneric: /(^|[^\w-])input(\b|[\s\[#.:>{,])/i.test(css),
    inputText: /\binput\[type\s*=\s*["']?text["']?\]/i.test(css),
    inputEmail: /\binput\[type\s*=\s*["']?email["']?\]/i.test(css),
    inputSearch: /\binput\[type\s*=\s*["']?search["']?\]/i.test(css),
    textarea: /\btextarea\b/i.test(css),
    select: /\bselect\b/i.test(css),
    button: /\bbutton\b/i.test(css),
    a: /\ba\b/i.test(css),
    label: /\blabel\b/i.test(css),
    img: /\bimg\b/i.test(css)
  };

  const parts = [];
  if (need.label) parts.push(`<span class="seg label">Label</span>`);
  if (need.inputText || need.inputGeneric) parts.push(`<input type="text" placeholder="Enter text">`);
  if (need.inputEmail) parts.push(`<input type="email" placeholder="name@example.com">`);
  if (need.inputSearch) parts.push(`<input type="search" placeholder="Search">`);
  if (need.textarea) parts.push(`<textarea rows="3" placeholder="Type here"></textarea>`);
  if (need.select) parts.push(`<select><option>One</option><option>Two</option></select>`);
  if (need.img) parts.push(`<img alt="preview" src="https://dummyimage.com/80x48/ddd/999.png&text=img">`);
  if (need.a) parts.push(`<a href="#">Link</a>`);
  if (need.button) parts.push(`<button>Submit</button>`);
  if (!parts.length) parts.push(`Button`);

  return `<div class="${className}">\n  ${parts.join("\n  ")}\n</div>`;
}

/* Build HTML using segmented-control hints when available */
function buildHtmlFromHints(hints, scope) {
  const className = getScopeClass(scope);
  const segs = Array.isArray(hints?.segments) ? hints.segments.filter(s => s.text) : [];
  if (!segs.length) return "";

  // Split into two chips if we detect a "compare" style token later in the list
  let splitIdx = segs.findIndex(s => /compare/i.test(s.text));
  if (splitIdx < 0) splitIdx = Number.MAX_SAFE_INTEGER;

  const groups = [segs.slice(0, splitIdx), segs.slice(splitIdx)].filter(g => g.length);

  const htmlGroups = groups.map(group => {
    const parts = [];
    group.forEach((s, i) => {
      // divider between items
      if (i > 0) parts.push(`<span class="divider"></span>`);
      const caretClass = s.caret ? " has-caret" : "";
      const safe = escapeHtml(s.text);
      if (s.role === "label") {
        parts.push(`<span class="seg label">${safe}</span>`);
      } else if (s.role === "link") {
        parts.push(`<a class="seg link${caretClass}" href="#">${safe}</a>`);
      } else if (s.role === "toggle" || s.role === "value" || s.role === "dropdown" || s.role === "unknown") {
        // Optional dot before “Compare”
        const dot = s.dot ? `<span class="seg dot" aria-hidden="true"></span>` : "";
        parts.push(`${dot}<button class="seg value${caretClass}">${safe}</button>`);
      } else {
        parts.push(`<span class="seg">${safe}</span>`);
      }
    });
    return `<div class="chip">\n  ${parts.join("\n  ")}\n</div>`;
  });

  return `<div class="${className}">\n${htmlGroups.join("\n")}\n</div>`;
}

async function suggestHtml({ baseModel, image, css, scope, component, hints, callOnce }) {
  try {
    const html = await callOnce("html", { model: baseModel, image, css, scope, component, hints });
    return htmlOnly(html);
  } catch {
    return "";
  }
}

function ensureScopedHtml(html, scope) {
  const className = getScopeClass(scope);
  const rootRe = new RegExp(`<([a-z0-9-]+)([^>]*class=["'][^"']*${escapeReg(className)}[^"']*["'][^>]*)>`, "i");
  if (rootRe.test(html)) return html.trim();
  return `<div class="${className}">\n${html.trim()}\n</div>`;
}

/* Ensure HTML contains elements that CSS styles (fallback safety) */
function ensureHtmlCoversCss(html, css, hints, scope) {
  let out = html.trim();
  const hasInputCSS = /(^|[^\w-])input(\b|[\s\[#.:>{,])/i.test(css);
  const hasButtonCSS = /\bbutton\b/i.test(css);
  const hasInputHTML = /<input\b/i.test(out);
  const hasButtonHTML = /<button\b/i.test(out);

  if (hasInputCSS && !hasInputHTML) {
    out = out.replace(/(<\/[a-z0-9-]+>\s*)$/i, `  <input type="text" placeholder="${escapeHtml(hints?.input_placeholder || 'Enter text')}">\n$1`);
  }
  if (hasButtonCSS && !hasButtonHTML) {
    out = out.replace(/(<\/[a-z0-9-]+>\s*)$/i, `  <button>${escapeHtml(hints?.button_text || 'Submit')}</button>\n$1`);
  }
  return out;
}

function applyTextHints(html, hints) {
  if (!hints) return html;
  let out = html;

  if (hints.button_text) {
    out = out.replace(/(<button[^>]*>)([\s\S]*?)(<\/button>)/i, (_, a, _txt, c) => `${a}${escapeHtml(hints.button_text)}${c}`);
  }
  if (hints.input_placeholder) {
    out = out.replace(/(<input\b[^>]*)(placeholder=["'][^"']*["'])?/i, (m, head, ph) => {
      if (/placeholder=/i.test(m)) {
        return m.replace(/placeholder=["'][^"']*["']/i, `placeholder="${escapeHtml(hints.input_placeholder)}"`);
      }
      return `${head} placeholder="${escapeHtml(hints.input_placeholder)}"`;
    });
  }
  return out;
}

function getScopeClass(scope = ".comp") { return String(scope || ".comp").trim().replace(/^\./, ""); }
function escapeReg(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function escapeHtml(s=""){ return String(s).replace(/[&<>"']/g, m=>({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[m])); }
function fallbackInner(componentHint = "component") {
  if (/input|field/i.test(componentHint)) return `<input type="text" placeholder="Enter text">`;
  if (/link|anchor/i.test(componentHint)) return `<a href="#">Link</a>`;
  if (/card/i.test(componentHint)) return `<div class="item"><h4>Title</h4><p>Body</p><button>Action</button></div>`;
  return `<button>Submit</button>`;
}
