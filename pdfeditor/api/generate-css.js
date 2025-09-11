// /pages/api/generate-css.js
// Image → CSS (literal, pill-aware). Returns { css, html, facts, used_model }.
// IMPORTANT: disable Next body parser; we read the stream ourselves.
export const config = { api: { bodyParser: false } };

import OpenAI from "openai";

/* ---------------- Model selection ---------------- */
const MODEL_CHAIN = [
  process.env.OPENAI_MODEL,   // optional override: "gpt-5", "gpt-5-mini"
  "gpt-5",
  "gpt-5-mini",
  "gpt-4o",
  "gpt-4o-mini",
].filter(Boolean);

const isGpt5 = (m) => /^gpt-5(\b|-)/i.test(m || "");
const is4o   = (m) => /^gpt-4o(-mini)?$/i.test(m || "");
const canSee = is4o; // multimodal image parts via chat.completions

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

    // Read raw JSON
    let raw = "";
    try { for await (const chunk of req) raw += chunk; }
    catch (e) { return sendError(res, 400, "Failed to read request body", e?.message); }

    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; }
    catch (e) { return sendError(res, 400, "Bad JSON", e?.message); }

    const { image, scope = ".comp", component = "component" } = body || {};

    if (!image || typeof image !== "string" || !/^data:image\//i.test(image)) {
      return sendError(res, 400, "Send { image: dataUrl, scope?, component? }");
    }
    if (image.length > 16_000_000) {
      return sendError(res, 413, "Image too large; please crop smaller.");
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const { resolveModel, callOnce } = wrapOpenAI(client);
    const model = await resolveModel();

    // 1) Extract literal facts from screenshot (vision JSON)
    const facts = await passFacts({ model, image, scope, component, callOnce });

    // 2) Build CSS literally from facts (no invention)
    let css = await passCssFromFacts({ model, image, scope, component, facts, callOnce });

    // 2b) Strict repair if empty
    if (!css || !css.trim()) {
      css = await passCssRepair({ model, image, scope, component, facts, callOnce });
    }
    // 2c) Last-ditch on 4o-mini if needed
    if (!css || !css.trim()) {
      css = await passCssFromFacts({ model: "gpt-4o-mini", image, scope, component, facts, callOnce });
    }

    // 3) Scope + final grammar repairs (no trailing commas / missing semicolons)
    css = enforceScope(css, scope);
    css = autofixCss(css);

    if (!css.trim()) {
      return sendError(res, 502, "Model returned no CSS", "Empty after repairs");
    }

    // 4) Return an HTML stub that matches the visible elements & text
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
        const soft = e?.status === 404 || /unknown|does not exist|restricted|Unsupported/i.test(msg);
        if (!soft) throw e;
      }
    }
    throw lastErr || new Error("No usable model");
  }
  async function resolveModel() {
    // tiny probe
    return tryEach(async (m) => {
      const probe = { model: m, messages: [{ role: "user", content: "ping" }] };
      if (isGpt5(m)) probe.max_completion_tokens = 8; else probe.max_tokens = 8;
      await client.chat.completions.create(probe);
    });
  }
  async function callOnce(kind, { model, messages }) {
    const budgets = { facts: 900, css: 1600 };
    const p = { model, messages };
    if (isGpt5(model)) {
      p.max_completion_tokens = budgets[kind] || 900; // GPT-5 param
    } else {
      p.max_tokens = budgets[kind] || 900;            // 4o/4o-mini param
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
    "Return JSON ONLY (no prose). Report objective, measurable style facts of ONE UI component screenshot. " +
    "Hex colors only (#RRGGBB). If not visible, leave empty/false. Do NOT invent gradients or shadows.";

  // Pill-aware + button text + caret + bg kind
  const schema = `
{
  "bg_kind": "solid" | "gradient" | "transparent",
  "background_color": string,
  "has_gradient": boolean,
  "gradient_direction": "to bottom" | "to right" | "to left" | "to top" | "",
  "gradient_stops": [ { "pos": number, "color": string } ],

  "border_present": boolean,
  "border_color": string,
  "border_width_px": number,
  "border_radius_px": number,
  "is_pill": boolean,
  "pill_radius_px": number,

  "shadow": { "x_px": number, "y_px": number, "blur_px": number, "spread_px": number, "color": string },

  "text_color": string,
  "font_size_px": number,
  "font_weight": number,
  "font_family": string,

  "padding_x_px": number,
  "padding_y_px": number,
  "gap_px": number,

  "caret_visible": boolean,
  "caret_color": string,

  "link_color": string,
  "link_underline": boolean,

  "button_text": string,
  "input_placeholder": string,
  "has_button": boolean,
  "has_input": boolean,
  "has_link": boolean,
  "has_icon": boolean
}`.trim();

  const instructions =
    `SCOPE: ${scope}\nCOMPONENT: ${component}\n` +
    "Measure literally. If a white chip pill is shown, set is_pill=true, bg_kind='solid', background_color '#FFFFFF', " +
    "border_present=true and border_color near '#E5E7EB'. Only set gradient if there are ≥2 distinct stops. " +
    "Round pixel values to integers. Include button_text exactly as rendered.\n\n" + schema;

  const messages = [
    { role: "system", content: sys },
    { role: "user", content: [
        { type: "text", text: instructions },
        { type: "image_url", image_url: { url: image, detail: "high" } }
      ] }
  ];

  const visModel = canSee(model) ? model : "gpt-4o";
  const raw = await callOnce("facts", { model: visModel, messages });
  return normalizeFacts(tryParseJson(raw));
}

async function passCssFromFacts({ model, image, scope, component, facts, callOnce }) {
  const sys =
    "Output VALID vanilla CSS only (no HTML/Markdown). Build styles literally from FACTS. " +
    "All selectors under SCOPE; no resets; no creativity.";

  const instructions =
    `SCOPE: ${scope}\nCOMPONENT: ${component}\n` +
    "- If bg_kind === 'gradient': background: linear-gradient(gradient_direction, stops).\n" +
    "- If bg_kind === 'solid': background-color exactly background_color.\n" +
    "- If is_pill === true: border-radius: 9999px (or pill_radius_px if larger).\n" +
    "- Apply border only when border_present (width/color).\n" +
    "- Apply shadow only if color present.\n" +
    "- Use text_color, font_size_px, font_weight, font_family if present.\n" +
    "- Apply paddings and gap (gap belongs on the container, not the button).\n" +
    "- If caret_visible: add a `.caret` SVG color rule.\n" +
    "- If link_color present: add scoped anchor rule; underline if link_underline.\n" +
    "Return CSS ONLY.\n\nFACTS JSON:\n" + JSON.stringify(facts);

  const messages = [
    { role: "system", content: sys },
    canSee(model)
      ? { role: "user", content: [{ type: "text", text: instructions }, { type: "image_url", image_url: { url: image, detail: "high" } }] }
      : { role: "user", content: instructions }
  ];

  const raw = await callOnce("css", { model, messages });
  return cssOnly(raw);
}

async function passCssRepair({ model, image, scope, component, facts, callOnce }) {
  const sys = "Return VALID CSS only (no HTML/Markdown). Previous CSS was empty. Build minimal literal CSS from FACTS under SCOPE.";
  const instructions =
    `SCOPE: ${scope}\nCOMPONENT: ${component}\n` +
    "Ensure braces/semicolons. No defaults that could be wrong (e.g., don't set text color if unknown). " +
    "Return CSS ONLY.\n\nFACTS JSON:\n" + JSON.stringify(facts);

  const messages = [
    { role: "system", content: sys },
    canSee(model)
      ? { role: "user", content: [{ type: "text", text: instructions }, { type: "image_url", image_url: { url: image, detail: "low" } }] }
      : { role: "user", content: instructions }
  ];

  const raw = await callOnce("css", { model, messages });
  return cssOnly(raw);
}

/* ---------------- HTML synthesis ---------------- */
function suggestHtml(css, scope, facts) {
  const cls = scope.replace(/^\./, "");
  const parts = [];

  if (facts?.has_icon) {
    parts.push(`<span class="icon" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="8"/></svg></span>`);
  }
  if (facts?.has_input) {
    const ph = facts?.input_placeholder || "Enter text";
    parts.push(`<input type="text" placeholder="${esc(ph)}">`);
  }
  if (facts?.has_button) {
    const label = facts?.button_text || "Button";
    parts.push(`<button type="button" aria-haspopup="listbox" aria-expanded="false"><span>${esc(label)}</span>${facts?.caret_visible ? caretSvg(facts?.caret_color) : ""}</button>`);
  }
  if (facts?.has_link) {
    parts.push(`<a href="#">${esc(facts?.button_text || "Link")}</a>`);
  }
  if (!parts.length) {
    parts.push(`<button type="button"><span>${esc(facts?.button_text || "Daily")}</span>${facts?.caret_visible ? caretSvg(facts?.caret_color) : ""}</button>`);
  }

  return `<div class="${cls}" role="group">\n  ${parts.join("\n  ")}\n</div>`;
}
function caretSvg(color) {
  const stroke = color && /^#/.test(color) ? color : "#6b7280";
  return ` <svg class="caret" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 9l6 6 6-6" stroke="${esc(stroke)}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/* ---------------- Utilities ---------------- */
function cssOnly(s=""){ return String(s).replace(/^```(?:css)?\s*/i, "").replace(/```$/i, "").trim(); }
function enforceScope(inputCss="", scope=".comp"){
  let css = cssOnly(inputCss);
  css = css.replace(/(^|})\s*([^@}{]+?)\s*\{/g,(m,p1,sel)=>{
    const scoped = sel.split(",").map(s=>s.trim()).map(x =>
      (!x || x.startsWith(scope) || x.startsWith(":root")) ? x : `${scope} ${x}`
    ).join(", ");
    return `${p1} ${scoped} {`;
  });
  return css.trim();
}
function autofixCss(css=""){
  let out = cssOnly(css);
  out = out.replace(/,\s*(;|\})/g,"$1");       // dangling commas
  out = out.replace(/([^;{}\s])\s*\}/g,"$1; }"); // missing semicolons
  const open=(out.match(/\{/g)||[]).length, close=(out.match(/\}/g)||[]).length;
  if(open>close) out += "}".repeat(open-close);
  return out.trim();
}
function tryParseJson(s){ try{ return JSON.parse(s); }catch{} const m=String(s||"").match(/\{[\s\S]*\}$/); if(m){ try{ return JSON.parse(m[0]); }catch{} } return {}; }
function normalizeFacts(f){
  const n=(v,d=0)=>Number.isFinite(+v)?Math.round(+v):d;
  const hex=(c)=>typeof c==="string"?c.trim():"";
  const b=(v)=>!!v;

  const out = {
    bg_kind: ["solid","gradient","transparent"].includes(f?.bg_kind) ? f.bg_kind
             : (f?.has_gradient ? "gradient" : (f?.background_color ? "solid" : "transparent")),
    background_color: hex(f?.background_color),
    has_gradient: !!f?.has_gradient,
    gradient_direction: typeof f?.gradient_direction==="string" ? f.gradient_direction : "",
    gradient_stops: Array.isArray(f?.gradient_stops) ? f.gradient_stops.map(s=>({
      pos: Number.isFinite(+s?.pos) ? Math.max(0,Math.min(1,+s.pos)) : 0,
      color: hex(s?.color)
    })) : [],

    border_present: b(f?.border_present),
    border_color: hex(f?.border_color),
    border_width_px: n(f?.border_width_px, 1),
    border_radius_px: n(f?.border_radius_px, 8),
    is_pill: b(f?.is_pill),
    pill_radius_px: n(f?.pill_radius_px, 9999),

    shadow: { x_px:n(f?.shadow?.x_px,0), y_px:n(f?.shadow?.y_px,0), blur_px:n(f?.shadow?.blur_px,0), spread_px:n(f?.shadow?.spread_px,0), color: hex(f?.shadow?.color||"") },

    text_color: typeof f?.text_color === "string" ? hex(f.text_color) : "", // no risky default
    font_size_px: n(f?.font_size_px,14),
    font_weight: n(f?.font_weight,500),
    font_family: typeof f?.font_family === "string" ? f.font_family : "",

    padding_x_px: n(f?.padding_x_px,12),
    padding_y_px: n(f?.padding_y_px,6),
    gap_px: n(f?.gap_px,8),

    caret_visible: b(f?.caret_visible),
    caret_color: hex(f?.caret_color || "#6b7280"),

    link_color: hex(f?.link_color || ""),
    link_underline: b(f?.link_underline),

    button_text: typeof f?.button_text==="string" ? f.button_text : "",
    input_placeholder: typeof f?.input_placeholder==="string" ? f.input_placeholder : "",
    has_button: b(f?.has_button),
    has_input: b(f?.has_input),
    has_link: b(f?.has_link),
    has_icon: b(f?.has_icon),
  };

  if (out.bg_kind === "gradient" && !out.gradient_stops.length) out.bg_kind = "transparent";
  return out;
}
function esc(s=""){ return String(s).replace(/[&<>"']/g,m=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m])); }
function sendError(res,status,error,details){ const p={ error:String(error||"Unknown") }; if(details) p.details=String(details); res.status(status).json(p); }
function extractErr(e){ if (e?.response?.data) { try { return JSON.stringify(e.response.data); } catch {} return String(e.response.data); } return String(e?.message||e); }
