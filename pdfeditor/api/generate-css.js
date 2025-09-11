// /api/generate-css.js
// Pixel-faithful, component-scoped CSS from an image with robust error paths.
// IMPORTANT: we disable Next.js bodyParser because we read the raw stream ourselves.
export const config = { api: { bodyParser: false } };

import OpenAI from "openai";

/* ---------------- Model selection ---------------- */
const MODEL_CHAIN = [
  process.env.OPENAI_MODEL,
  "gpt-5",
  "gpt-5-mini",
  "gpt-4o",
  "gpt-4o-mini",
].filter(Boolean);

const DEFAULT_MODEL = MODEL_CHAIN[0] || "gpt-4o-mini";

const isGpt5 = (m) => /^gpt-5(\b|-)/i.test(m || "");
const supportsVision = (m) => /gpt-4o(-mini)?$/i.test(m || "");

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

    // ---- Read raw JSON body safely ----
    let raw = "";
    try {
      for await (const chunk of req) raw += chunk;
    } catch (e) {
      return sendError(res, 400, "Failed to read request body", e?.message);
    }

    let body;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch (e) {
      return sendError(res, 400, "Bad JSON", e?.message);
    }

    const {
      image,
      scope = ".comp",
      component = "component",
      double_checks = 1,
    } = body || {};

    if (!image || typeof image !== "string" || !/^data:image\//i.test(image)) {
      return sendError(res, 400, "Send { image: dataUrl, scope?, component?, double_checks? }");
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const { resolveModel, callOnce } = makeOpenAI(client);

    const model = await resolveModel();

    // 1) FACTS (strict JSON from screenshot)
    const facts = await safeFacts({ model, image, scope, component, callOnce });

    // 2) CSS from facts (literal)
    let css = await safeCssFromFacts({ model, image, scope, component, facts, callOnce });

    // 3) QA / repair
    css = enforceScope(css, scope);
    css = autofixCss(css);
    if (!css.trim()) {
      return sendError(res, 502, "Model returned no CSS", "Empty CSS after attempts.");
    }

    // 4) HTML snippet that covers all selectors & uses visible text
    let html = suggestHtmlFromFacts(css, scope, facts);
    if (!html || !html.trim()) {
      html = `<div class="${getScopeClass(scope)}"><button>${escapeHtml(facts?.button_text || "Submit")}</button></div>`;
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ css, html, facts, scope, component, used_model: model });

  } catch (err) {
    return sendError(res, 500, "Failed to generate CSS.", extractErrMsg(err));
  }
}

/* ---------------- OpenAI wrappers ---------------- */

function buildParams(model, kind, messages) {
  const budget = { facts: 900, css: 1400 };
  const max = budget[kind] || 900;
  const base = { model, messages };
  if (isGpt5(model)) {
    base.max_completion_tokens = max;   // GPT-5 uses this; no temperature override
  } else {
    base.max_tokens = max;              // 4o / 4o-mini
    base.temperature = kind === "facts" ? 0.0 : 0.1;
  }
  return base;
}

function makeOpenAI(client) {
  async function tryEach(run) {
    let lastErr;
    for (const m of (MODEL_CHAIN.length ? MODEL_CHAIN : [DEFAULT_MODEL])) {
      try { await run(m); return m; }
      catch (e) {
        lastErr = e;
        const msg = (e && e.message) ? String(e.message) : "";
        const soft = e?.status === 404 || /does not exist|unknown model|restricted/i.test(msg);
        if (!soft) throw e;
      }
    }
    throw lastErr || new Error("No usable model found");
  }

  async function resolveModel() {
    return await tryEach(async (m) => {
      // tiny ping—if this fails, model is unusable
      if (isGpt5(m)) {
        await client.chat.completions.create({ model: m, messages: [{ role: "user", content: "ping" }], max_completion_tokens: 16 });
      } else {
        await client.chat.completions.create({ model: m, messages: [{ role: "user", content: "ping" }], max_tokens: 16 });
      }
    });
  }

  async function callOnce(kind, { model, messages }) {
    const params = buildParams(model, kind, messages);
    const r = await client.chat.completions.create(params);
    return r?.choices?.[0]?.message?.content ?? "";
  }

  return { resolveModel, callOnce };
}

/* ---------------- Passes ---------------- */

async function safeFacts({ model, image, scope, component, callOnce }) {
  const sys =
    "You return JSON ONLY. Describe objective, measurable style facts of ONE UI component screenshot. " +
    "No creativity. If a property is not visible, leave it empty/false. JSON must be valid and match the schema exactly.";

  const schema = `
Return EXACTLY this JSON (no markdown):

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
}
`.trim();

  const visionModel = supportsVision(model) ? model : "gpt-4o";
  const messages = [
    { role: "system", content: sys },
    { role: "user", content: [
        { type: "text", text: [
            `SCOPE CLASS: ${scope}`,
            `COMPONENT: ${component}`,
            "Return literal measured values. Colors must be hex #RRGGBB.",
            "Gradients ONLY if visually evident; else use background_color.",
            "Round px values to nearest integer.",
            "", schema
          ].join("\n")
        },
        { type: "image_url", image_url: { url: image, detail: "high" } }
      ]
    }
  ];

  let raw = await callOnce("facts", { model: visionModel, messages });
  let obj = tryParseJson(raw);
  if (!obj || typeof obj !== "object") obj = {};
  return normalizeFacts(obj);
}

async function safeCssFromFacts({ model, image, scope, component, facts, callOnce }) {
  const sys =
    "Output VALID vanilla CSS only (no HTML/Markdown). Rebuild the stylesheet literally from FACTS. " +
    "Do not invent gradients, shadows, fonts, or colors. Scope all selectors under SCOPE CLASS. No resets.";

  const instructions = [
    `SCOPE CLASS: ${scope}`,
    `COMPONENT: ${component}`,
    "Recreate styles literally:",
    "- If has_gradient true, use linear-gradient with gradient_direction and gradient_stops.",
    "- Else use background-color with background_color.",
    "- Apply border (width/color) and border-radius.",
    "- Apply box-shadow only if shadow.color is not empty.",
    "- Use text_color, font_size_px, font_weight, padding_x/y.",
    "- If link_color present, add a scoped anchor rule with color and underline if link_underline is true.",
    "- Use gap if the component is multi-item.",
    "Return CSS ONLY."
  ].join("\n");

  const messages = [
    { role: "system", content: sys },
    { role: "user", content: [
        { type: "text", text: instructions + "\n\nFACTS JSON:\n" + JSON.stringify(facts) },
        supportsVision(model)
          ? { type: "image_url", image_url: { url: image, detail: "high" } }
          : { type: "text", text: "(image omitted)" }
      ]
    }
  ];

  let raw = await callOnce("css", { model, messages });
  return cssOnly(raw);
}

/* ---------------- HTML from facts ---------------- */

function suggestHtmlFromFacts(css, scope, facts) {
  const className = getScopeClass(scope);
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
    parts.push(`<a href="#">${escapeHtml(facts.button_text || "Previous period")}</a>`);
  }
  if (!parts.length) {
    parts.push(`<span class="text">${escapeHtml(facts?.button_text || "Label")}</span>`);
    parts.push(`<span class="dropdown" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`);
  }

  return `<div class="${className}" role="button" tabindex="0">\n  ${parts.join("\n  ")}\n</div>`;
}

/* ---------------- Utilities ---------------- */

function tryParseJson(s) {
  try { return JSON.parse(s); } catch {}
  const m = String(s || "").match(/\{[\s\S]*\}$/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

function normalizeFacts(f) {
  const n = (v, d=0)=> (Number.isFinite(+v) ? Math.round(+v) : d);
  const hex = (c)=> typeof c === "string" ? c.trim() : "";
  const b = (v)=> !!v;

  const out = {
    has_gradient: !!f.has_gradient,
    gradient_direction: typeof f.gradient_direction === "string" ? f.gradient_direction : "",
    gradient_stops: Array.isArray(f.gradient_stops) ? f.gradient_stops.map(s => ({
      pos: Number.isFinite(+s.pos) ? Math.max(0, Math.min(1, +s.pos)) : 0,
      color: hex(s.color)
    })) : [],
    background_color: hex(f.background_color),
    border_color: hex(f.border_color),
    border_width_px: n(f.border_width_px, 1),
    border_radius_px: n(f.border_radius_px, 8),
    shadow: {
      x_px: n(f?.shadow?.x_px, 0),
      y_px: n(f?.shadow?.y_px, 0),
      blur_px: n(f?.shadow?.blur_px, 0),
      spread_px: n(f?.shadow?.spread_px, 0),
      color: hex(f?.shadow?.color || "")
    },
    text_color: hex(f.text_color || "#000000"),
    font_size_px: n(f.font_size_px, 14),
    font_weight: n(f.font_weight, 600),
    padding_x_px: n(f.padding_x_px, 12),
    padding_y_px: n(f.padding_y_px, 6),
    gap_px: n(f.gap_px, 8),
    link_color: hex(f.link_color || ""),
    link_underline: b(f.link_underline),
    button_text: typeof f.button_text === "string" ? f.button_text : "",
    input_placeholder: typeof f.input_placeholder === "string" ? f.input_placeholder : "",
    has_button: b(f.has_button),
    has_input: b(f.has_input),
    has_link: b(f.has_link),
    has_icon: b(f.has_icon)
  };

  if (!out.has_gradient || !out.gradient_stops.length) {
    out.has_gradient = false;
    out.gradient_direction = "";
    out.gradient_stops = [];
  }
  return out;
}

function cssOnly(text=""){ return String(text).replace(/^```(?:css)?\s*/i, "").replace(/```$/i, "").trim(); }
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
  out = out.replace(/,\s*(;|\})/g, "$1");        // dangling commas before ; or }
  out = out.replace(/([^;\{\}\s])\s*\}/g, "$1; }");
  const open = (out.match(/\{/g) || []).length;
  const close = (out.match(/\}/g) || []).length;
  if (open > close) out += "}".repeat(open - close);
  return out.trim();
}

function getScopeClass(scope = ".comp") { return String(scope || ".comp").trim().replace(/^\./, ""); }
function escapeHtml(s=""){ return String(s).replace(/[&<>"']/g, m=>({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[m])); }

/* ---------------- Error helpers ---------------- */

function sendError(res, status, error, details) {
  const payload = { error: String(error || "Unknown") };
  if (details) payload.details = String(details);
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
