// /pages/api/generate-css.js
// Pixel-faithful, component-scoped CSS from an image, with robust fallbacks.
// IMPORTANT: disable Next bodyParser because we read the raw stream ourselves.
export const config = { api: { bodyParser: false } };

import OpenAI from "openai";

/* ---------------- Model selection ---------------- */
const MODEL_CHAIN = [
  process.env.OPENAI_MODEL,    // optional override, e.g. "gpt-5", "gpt-5-mini"
  "gpt-5", "gpt-5-mini",       // will be used only if enabled on your account
  "gpt-4o",
  "gpt-4o-mini",
].filter(Boolean);

const isGpt5 = (m) => /^gpt-5(\b|-)/i.test(m || "");
const is4o = (m) => /^gpt-4o(-mini)?$/i.test(m || "");
const supportsVision = is4o;   // vision images via chat.completions content parts

/* ---------------- HTTP handler ---------------- */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }
    if (!process.env.OPENAI_API_KEY) {
      return sendError(res, 500, "OPENAI_API_KEY not configured");
    }

    // Read raw JSON body
    let raw = "";
    try { for await (const chunk of req) raw += chunk; }
    catch (e) { return sendError(res, 400, "Failed to read request body", e?.message); }

    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; }
    catch (e) { return sendError(res, 400, "Bad JSON", e?.message); }

    const {
      image,
      scope = ".comp",
      component = "component",
    } = body || {};

    if (!image || typeof image !== "string" || !/^data:image\//i.test(image)) {
      return sendError(res, 400, "Send { image: dataUrl, scope?, component? }");
    }
    if (image.length > 16_000_000) {
      return sendError(res, 413, "Image too large; please send a smaller crop.");
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const { resolveModel, callOnce } = wrapOpenAI(client);
    const model = await resolveModel();         // e.g., "gpt-5" or "gpt-4o"

    // 1) FACTS from screenshot (vision JSON)
    const facts = await passFacts({ model, image, scope, component, callOnce });

    // 2) CSS from facts (literal)
    let css = await passCssFromFacts({ model, image, scope, component, facts, callOnce });

    // If CSS empty, try a strict repair prompt
    if (!css || !css.trim()) {
      css = await passCssRepair({ model, image, scope, component, facts, callOnce });
    }

    // If still empty, last-ditch on 4o-mini
    if (!css || !css.trim()) {
      css = await passCssFromFacts({ model: "gpt-4o-mini", image, scope, component, facts, callOnce });
    }

    // 3) Scope + auto-repair braces/semicolons
    css = enforceScope(css, scope);
    css = autofixCss(css);

    if (!css.trim()) {
      return sendError(res, 502, "Model returned no CSS", "Empty after repairs");
    }

    // 4) Minimal HTML stub that fits selectors & visible text
    const html = suggestHtml(css, scope, facts);

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ css, html, facts, scope, component, used_model: model });
  } catch (err) {
    return sendError(res, 500, "Failed to generate CSS.", extractErr(err));
  }
}

/* ---------------- OpenAI wrappers ---------------- */
function wrapOpenAI(client) {
  async function tryEach(run) {
    let lastErr;
    for (const m of (MODEL_CHAIN.length ? MODEL_CHAIN : ["gpt-4o-mini"])) {
      try { await run(m); return m; }
      catch (e) {
        lastErr = e;
        const msg = String(e?.message || "");
        const soft = e?.status === 404 || /unknown|does not exist|restricted|Unsupported model/i.test(msg);
        if (!soft) throw e; // real failure (auth/network)
      }
    }
    throw lastErr || new Error("No usable model");
  }

  async function resolveModel() {
    // Probe the model with a tiny ping
    return tryEach(async (m) => {
      const probe = { model: m, messages: [{ role: "user", content: "ping" }] };
      if (isGpt5(m)) probe.max_completion_tokens = 8;
      else probe.max_tokens = 8;
      await client.chat.completions.create(probe);
    });
  }

  async function callOnce(kind, { model, messages }) {
    const budgets = { facts: 900, css: 1600 };
    const p = { model, messages };
    if (isGpt5(model)) {
      p.max_completion_tokens = budgets[kind] || 900;  // GPT-5 param
    } else {
      p.max_tokens = budgets[kind] || 900;             // 4o/4o-mini param
      p.temperature = kind === "facts" ? 0 : 0.1;
    }
    const r = await client.chat.completions.create(p);
    return r?.choices?.[0]?.message?.content ?? "";
  }

  return { resolveModel, callOnce };
}

/* ---------------- Passes ---------------- */

async function passFacts({ model, image, scope, component, callOnce }) {
  const sys =
    "Return JSON ONLY. Describe objective style facts of ONE UI component screenshot. " +
    "Hex colors only. If not visible, leave empty/false. JSON must match the schema exactly.";

  const schema = `
{
  "has_gradient": boolean,
  "gradient_direction": "to bottom" | "to right" | "to left" | "to top" | "",
  "gradient_stops": [ { "pos": number, "color": string } ],
  "background_color": string,
  "border_color": string,
  "border_width_px": number,
  "border_radius_px": number,
  "shadow": { "x_px": number, "y_px": number, "blur_px": number, "spread_px": number, "color": string },
  "text_color": string,
  "font_size_px": number,
  "font_weight": number,
  "padding_x_px": number,
  "padding_y_px": number,
  "gap_px": number,
  "link_color": string,
  "link_underline": boolean,

  "button_text": string,
  "input_placeholder": string,
  "has_button": boolean,
  "has_input": boolean,
  "has_link": boolean,
  "has_icon": boolean
}`.trim();

  // Always use a vision model for the Facts pass
  const visionModel = supportsVision(model) ? model : "gpt-4o";
  const userText =
    `SCOPE: ${scope}\nCOMPONENT: ${component}\n` +
    "Return literal measured values. Colors must be #RRGGBB. Round px to integers.\n" +
    "Use this schema exactly:\n" + schema;

  const messages = [
    { role: "system", content: sys },
    {
      role: "user",
      content: [
        { type: "text", text: userText },
        { type: "image_url", image_url: { url: image, detail: "high" } }
      ]
    }
  ];

  const raw = await callOnce("facts", { model: visionModel, messages });
  const obj = tryParseJson(raw) || {};
  return normalizeFacts(obj);
}

async function passCssFromFacts({ model, image, scope, component, facts, callOnce }) {
  const sys =
    "Output VALID vanilla CSS only (no HTML/Markdown). Build styles literally from FACTS. " +
    "All selectors must be under SCOPE. No resets.";

  const instructions =
    `SCOPE: ${scope}\nCOMPONENT: ${component}\n` +
    "- If has_gradient is true, use linear-gradient with gradient_direction & gradient_stops.\n" +
    "- Else use background-color.\n" +
    "- Apply border (width/color), border-radius, shadow if present, text color/size/weight, paddings, gap.\n" +
    "- If link_color present, add a scoped anchor rule; underline if link_underline is true.\n" +
    "Return CSS ONLY.\n\nFACTS JSON:\n" + JSON.stringify(facts);

  const messages = [
    { role: "system", content: sys },
    // IMPORTANT: if model is NOT vision, send a plain string instead of a content array.
    supportsVision(model)
      ? { role: "user", content: [
          { type: "text", text: instructions },
          { type: "image_url", image_url: { url: image, detail: "high" } }
        ] }
      : { role: "user", content: instructions }
  ];

  const raw = await callOnce("css", { model, messages });
  return cssOnly(raw);
}

async function passCssRepair({ model, image, scope, component, facts, callOnce }) {
  const sys = "Return VALID CSS only (no HTML/Markdown). Repair empty or malformed CSS using FACTS. Scope under SCOPE.";
  const instructions =
    `SCOPE: ${scope}\nCOMPONENT: ${component}\n` +
    "Earlier attempt produced empty CSS. Synthesize minimal but correct CSS from FACTS. " +
    "Ensure braces/semicolons are correct. Return CSS ONLY.\n\nFACTS JSON:\n" + JSON.stringify(facts);

  const messages = [
    { role: "system", content: sys },
    supportsVision(model)
      ? { role: "user", content: [
          { type: "text", text: instructions },
          { type: "image_url", image_url: { url: image, detail: "low" } }
        ] }
      : { role: "user", content: instructions }
  ];

  const raw = await callOnce("css", { model, messages });
  return cssOnly(raw);
}

/* ---------------- HTML from facts ---------------- */
function suggestHtml(css, scope, facts) {
  const className = scope.replace(/^\./, "");
  const parts = [];

  if (facts?.has_icon) {
    parts.push(`<span class="icon" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="8"/></svg></span>`);
  }
  if (facts?.has_input) {
    const ph = facts?.input_placeholder || "Enter text";
    parts.push(`<input type="text" placeholder="${escapeHtml(ph)}">`);
  }
  if (facts?.has_button) {
    const label = facts?.button_text || "Submit";
    parts.push(`<button>${escapeHtml(label)}</button>`);
  }
  if (facts?.has_link) {
    // Use button_text as a generic label if link text not explicitly detected
    parts.push(`<a href="#">${escapeHtml(facts?.button_text || "Previous period")}</a>`);
  }
  if (!parts.length) {
    parts.push(`<span class="text">${escapeHtml(facts?.button_text || "Label")}</span>`);
  }

  return `<div class="${className}" role="button" tabindex="0">\n  ${parts.join("\n  ")}\n</div>`;
}

/* ---------------- Utilities ---------------- */
function cssOnly(s = "") { return String(s).replace(/^```(?:css)?\s*/i, "").replace(/```$/i, "").trim(); }
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
function autofixCss(css = "") {
  let out = cssOnly(css);
  out = out.replace(/,\s*(;|\})/g, "$1");           // dangling commas
  out = out.replace(/([^;{}\s])\s*\}/g, "$1; }");  // missing semicolons before }
  const open = (out.match(/\{/g) || []).length;
  const close = (out.match(/\}/g) || []).length;
  if (open > close) out += "}".repeat(open - close);
  return out.trim();
}
function tryParseJson(s) {
  try { return JSON.parse(s); } catch {}
  const m = String(s || "").match(/\{[\s\S]*\}$/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}
function normalizeFacts(f) {
  const n = (v,d=0)=>Number.isFinite(+v)?Math.round(+v):d;
  const hex = (c)=>typeof c==="string"?c.trim():"";
  const b = (v)=>!!v;
  const out = {
    has_gradient: !!f?.has_gradient,
    gradient_direction: typeof f?.gradient_direction==="string"?f.gradient_direction:"",
    gradient_stops: Array.isArray(f?.gradient_stops) ? f.gradient_stops.map(s=>({
      pos: Number.isFinite(+s?.pos) ? Math.max(0, Math.min(1, +s.pos)) : 0,
      color: hex(s?.color)
    })) : [],
    background_color: hex(f?.background_color),
    border_color: hex(f?.border_color),
    border_width_px: n(f?.border_width_px, 1),
    border_radius_px: n(f?.border_radius_px, 8),
    shadow: {
      x_px: n(f?.shadow?.x_px, 0),
      y_px: n(f?.shadow?.y_px, 0),
      blur_px: n(f?.shadow?.blur_px, 0),
      spread_px: n(f?.shadow?.spread_px, 0),
      color: hex(f?.shadow?.color || "")
    },
    text_color: hex(f?.text_color || "#111827"),
    font_size_px: n(f?.font_size_px, 14),
    font_weight: n(f?.font_weight, 600),
    padding_x_px: n(f?.padding_x_px, 12),
    padding_y_px: n(f?.padding_y_px, 6),
    gap_px: n(f?.gap_px, 8),
    link_color: hex(f?.link_color || ""),
    link_underline: b(f?.link_underline),
    button_text: typeof f?.button_text==="string" ? f.button_text : "",
    input_placeholder: typeof f?.input_placeholder==="string" ? f.input_placeholder : "",
    has_button: b(f?.has_button),
    has_input: b(f?.has_input),
    has_link: b(f?.has_link),
    has_icon: b(f?.has_icon)
  };
  if (!out.has_gradient || !out.gradient_stops.length) {
    out.has_gradient = false; out.gradient_direction = ""; out.gradient_stops = [];
  }
  return out;
}
function escapeHtml(s=""){ return String(s).replace(/[&<>"']/g, m => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m])); }

/* ---------------- Error helpers ---------------- */
function sendError(res, status, error, details) {
  const payload = { error: String(error || "Unknown") };
  if (details) payload.details = String(details);
  res.status(status).json(payload);
}
function extractErr(err) {
  if (err?.response?.data) {
    try { return JSON.stringify(err.response.data); } catch {}
    return String(err.response.data);
  }
  return String(err?.message || err);
}
