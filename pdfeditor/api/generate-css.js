// /pages/api/generate-css.js
// Robust: disables bodyParser (we read the raw stream), returns JSON errors (no platform 502s).
export const config = { api: { bodyParser: false } };

import OpenAI from "openai";

/* ---------- Model selection ---------- */
const MODEL_CHAIN = [
  process.env.OPENAI_MODEL,   // optional override
  "gpt-5", "gpt-5-mini",      // try 5 first (if your account has it)
  "gpt-4o", "gpt-4o-mini",    // fallbacks
].filter(Boolean);

const isGpt5 = (m) => /^gpt-5(\b|-)/i.test(m || "");
const supportsVision = (m) => /gpt-4o(-mini)?$/i.test(m || "");

/* ---------- Handler ---------- */
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
    // Oversize guard (data URL ~ base64), 12MB hard stop
    if (image.length > 16_000_000) {
      return sendError(res, 413, "Image too large; please send a smaller crop.");
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const { resolveModel, callOnce } = wrapOpenAI(client);
    const model = await resolveModel();

    // 1) Facts (vision JSON)
    const facts = await passFacts({ model, client, image, scope, component, callOnce });

    // 2) Build CSS literally from facts
    let css = await passCssFromFacts({ model, client, image, scope, component, facts, callOnce });

    // 3) Scope + auto-repair
    css = enforceScope(css, scope);
    css = autofixCss(css);
    if (!css.trim()) return sendError(res, 502, "Model returned no CSS", "Empty after repairs");

    // 4) Minimal HTML stub that fits selectors & visible text
    const html = suggestHtml(css, scope, facts);

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ css, html, facts, scope, component, used_model: model });
  } catch (err) {
    return sendError(res, 500, "Failed to generate CSS.", extractErr(err));
  }
}

/* ---------- OpenAI helpers ---------- */
function wrapOpenAI(client) {
  async function tryEach(run) {
    let last;
    for (const m of MODEL_CHAIN) {
      try { await run(m); return m; }
      catch (e) {
        last = e;
        const msg = String(e?.message || "");
        const soft = e?.status === 404 || /unknown|does not exist|restricted/i.test(msg);
        if (!soft) throw e;
      }
    }
    throw last || new Error("No usable model");
  }
  async function resolveModel() {
    return tryEach(async (m) => {
      const probe = { model: m, messages: [{ role: "user", content: "ping" }] };
      if (isGpt5(m)) probe.max_completion_tokens = 16; else probe.max_tokens = 16;
      await client.chat.completions.create(probe);
    });
  }
  async function callOnce(kind, { model, messages }) {
    const budgets = { facts: 900, css: 1200 };
    const p = { model, messages };
    if (isGpt5(model)) p.max_completion_tokens = budgets[kind] || 900;
    else { p.max_tokens = budgets[kind] || 900; p.temperature = kind === "facts" ? 0 : 0.1; }
    const r = await client.chat.completions.create(p);
    return r?.choices?.[0]?.message?.content ?? "";
  }
  return { resolveModel, callOnce };
}

/* ---------- Passes ---------- */
async function passFacts({ model, image, scope, component, callOnce }) {
  const visModel = supportsVision(model) ? model : "gpt-4o";
  const sys =
    "Return JSON ONLY with objective style facts measured from ONE UI component screenshot. " +
    "No creativity. If not visible, leave empty/false. Hex colors only.";
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

  const messages = [
    { role: "system", content: sys },
    { role: "user", content: [
        { type: "text", text: `SCOPE: ${scope}\nCOMPONENT: ${component}\nUse this schema exactly:\n${schema}` },
        { type: "image_url", image_url: { url: image, detail: "high" } }
      ]
    }
  ];
  const raw = await callOnce("facts", { model: visModel, messages });
  return normalizeFacts(tryParseJson(raw));
}

async function passCssFromFacts({ model, image, scope, component, facts, callOnce }) {
  const sys =
    "Output VALID vanilla CSS only (no HTML/Markdown). Build the style literally from FACTS. " +
    "All selectors scoped under the given SCOPE CLASS. No resets.";
  const msg = [
    `SCOPE: ${scope}`,
    `COMPONENT: ${component}`,
    "Use background_color unless has_gradient is true (then use linear-gradient with gradient_direction & gradient_stops).",
    "Apply border (width/color), border-radius, shadow (if color present), text color/size/weight, paddings, gap.",
    "If link_color present, add a scoped anchor rule; underline if link_underline is true.",
    "Return CSS ONLY."
  ].join("\n");
  const messages = [
    { role: "system", content: sys },
    { role: "user", content: [
        { type: "text", text: msg + "\n\nFACTS JSON:\n" + JSON.stringify(facts) },
        supportsVision(model)
          ? { type: "image_url", image_url: { url: image, detail: "high" } }
          : { type: "text", text: "(image omitted)" }
      ] }
  ];
  return cssOnly(await callOnce("css", { model, messages }));
}

/* ---------- HTML synthesis ---------- */
function suggestHtml(css, scope, facts) {
  const cl = getScope(scope);
  const parts = [];
  if (facts?.has_icon) {
    parts.push(`<span class="icon" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="8"/></svg></span>`);
  }
  if (facts?.has_input) {
    parts.push(`<input type="text" placeholder="${esc(facts?.input_placeholder || "Enter text")}">`);
  }
  if (facts?.has_button) {
    parts.push(`<button>${esc(facts?.button_text || "Submit")}</button>`);
  }
  if (facts?.has_link) {
    parts.push(`<a href="#">${esc(facts?.button_text || "Previous period")}</a>`);
  }
  if (!parts.length) {
    parts.push(`<span class="text">${esc(facts?.button_text || "Label")}</span>`);
  }
  return `<div class="${cl}" role="button" tabindex="0">\n  ${parts.join("\n  ")}\n</div>`;
}

/* ---------- Utils ---------- */
function cssOnly(s=""){ return String(s).replace(/^```(?:css)?\s*/i, "").replace(/```$/i, "").trim(); }
function enforceScope(css="", scope=".comp"){
  let out = cssOnly(css);
  out = out.replace(/(^|})\s*([^@}{]+?)\s*\{/g,(m,p1,sel)=>{
    const scoped = sel.split(",").map(s=>s.trim()).map(s=>(!s||s.startsWith(scope)||s.startsWith(":root"))?s:`${scope} ${s}`).join(", ");
    return `${p1} ${scoped} {`;
  });
  return out.trim();
}
function autofixCss(css=""){
  let out = cssOnly(css);
  out = out.replace(/,\s*(;|\})/g,"$1");
  out = out.replace(/([^;{}\s])\s*\}/g,"$1; }");
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
    has_gradient: !!f.has_gradient,
    gradient_direction: typeof f.gradient_direction==="string"?f.gradient_direction:"",
    gradient_stops: Array.isArray(f.gradient_stops)?f.gradient_stops.map(s=>({pos:Number.isFinite(+s.pos)?Math.max(0,Math.min(1,+s.pos)):0,color:hex(s.color)})):[],
    background_color: hex(f.background_color),
    border_color: hex(f.border_color),
    border_width_px: n(f.border_width_px,1),
    border_radius_px: n(f.border_radius_px,8),
    shadow: { x_px:n(f?.shadow?.x_px,0), y_px:n(f?.shadow?.y_px,0), blur_px:n(f?.shadow?.blur_px,0), spread_px:n(f?.shadow?.spread_px,0), color:hex(f?.shadow?.color||"") },
    text_color: hex(f.text_color || "#111827"),
    font_size_px: n(f.font_size_px,14),
    font_weight: n(f.font_weight,600),
    padding_x_px: n(f.padding_x_px,12),
    padding_y_px: n(f.padding_y_px,6),
    gap_px: n(f.gap_px,8),
    link_color: hex(f.link_color || ""),
    link_underline: b(f.link_underline),
    button_text: typeof f.button_text==="string"?f.button_text:"",
    input_placeholder: typeof f.input_placeholder==="string"?f.input_placeholder:"",
    has_button: b(f.has_button),
    has_input: b(f.has_input),
    has_link: b(f.has_link),
    has_icon: b(f.has_icon),
  };
  if(!out.has_gradient || !out.gradient_stops.length){
    out.has_gradient=false; out.gradient_direction=""; out.gradient_stops=[];
  }
  return out;
}
function getScope(scope=".comp"){ return String(scope).replace(/^\./,""); }
function esc(s=""){ return String(s).replace(/[&<>"']/g,m=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m])); }
function sendError(res,status,error,details){ const p={ error:String(error||"Unknown") }; if(details) p.details=String(details); res.status(status).json(p); }
function extractErr(e){ if(e?.response?.data){ try{ return JSON.stringify(e.response.data); }catch{} return String(e.response.data); } return String(e?.message||e); }
