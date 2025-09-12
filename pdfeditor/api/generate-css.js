// /api/generate-css.js
// Vision → JSON spec → deterministic codegen (now supports composite "banner" containers)
// Returns: { css, html, spec, notes, scope, component, used_model }

import OpenAI from "openai";

/* ---------------- Model selection ---------------- */
const MODEL_CHAIN = [
  process.env.OPENAI_MODEL, // optional override
  "gpt-5",                  // prefer 5 if available
  "gpt-5-mini",
  "gpt-4o",
  "gpt-4o-mini"
].filter(Boolean);

const FALLBACK_MODEL = "gpt-4o-mini";
const isGpt5 = (m) => /^gpt-5(\b|-)/i.test(m);
const supportsVision = (m) => /gpt-4o(?:-mini)?$/i.test(m); // safe vision default

/* ---------------- Handler ---------------- */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    let raw = "";
    for await (const chunk of req) raw += chunk;

    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; }
    catch (e) { return sendError(res, 400, "Bad JSON", e?.message); }

    const {
      image,
      scope = ".comp",
      component = "component",
      force_solid = false,
      solid_color = "",
      debug = false
    } = body;

    if (!image || typeof image !== "string" || !/^data:image\//i.test(image)) {
      return sendError(res, 400, "Send { image: dataUrl, scope?, component?, force_solid?, solid_color? }");
    }
    if (!process.env.OPENAI_API_KEY) {
      return sendError(res, 500, "OPENAI_API_KEY not configured");
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = await resolveUsableModel(client);

    // 1) Vision → strict JSON spec (now composite-aware)
    const spec = await getStyleSpec(client, model, { image, scope, component });

    // 2) Deterministic codegen (handles button/input/segmented + banner/container with children)
    let { css, html, notes } = codegen(spec, { scope, force_solid, solid_color });

    // 3) Safety: scope + autofix + base font/reset + ensure scoped HTML wrapper
    css = enforceScope(css, scope);
    css = autofixCss(css);
    css = ensureBaseFontAndResets(css, scope);
    html = ensureScopedHtml(html, scope);

    if (!css.trim()) return sendError(res, 502, "Model returned empty CSS spec");

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      css,
      html,
      spec,
      notes,
      scope,
      component,
      used_model: model,
      ...(debug ? { debug: { model_chain: MODEL_CHAIN } } : {})
    });
  } catch (err) {
    return sendError(res, 500, "Failed to generate CSS.", extractErrMsg(err));
  }
}

/* ---------------- OpenAI glue ---------------- */

async function resolveUsableModel(client) {
  for (const m of (MODEL_CHAIN.length ? MODEL_CHAIN : [FALLBACK_MODEL])) {
    try {
      const params = isGpt5(m) ? { max_completion_tokens: 16 } : { max_tokens: 16 };
      await client.chat.completions.create({
        model: m,
        messages: [{ role: "user", content: "ping" }],
        ...params
      });
      return m;
    } catch (e) {
      const msg = String(e?.message || "");
      const soft = e?.status === 404 || /does not exist|unsupported|unknown/i.test(msg);
      if (!soft) throw e;
    }
  }
  return FALLBACK_MODEL;
}

async function getStyleSpec(client, model, { image, scope, component }) {
  const useModel = supportsVision(model) ? model : "gpt-4o";
  const sys =
    "You are a UI vision measurer. Return a STRICT JSON spec describing one component or a composite banner/container.\n" +
    "Extract ALL visible text verbatim (no summarizing). If you see a banner-like container with an icon/left copy and a right CTA, " +
    "return type:'banner' and include children for icon/title/text/button. No markdown. Only JSON.";

  // Composite-aware schema
  const schema = {
    type: "object",
    properties: {
      type: { enum: ["button","input","segmented","chip","badge","link","card","toggle","checkbox","radio","banner","container","unknown"] },
      text: { type: "string" },
      html_hint: { enum: ["button","a","input","div"] },
      items: { type: "array", items: { type: "object" } }, // legacy (segmented)
      children: {
        type: "array",
        description: "For banner/container: ordered left-to-right content pieces",
        items: {
          type: "object",
          properties: {
            kind: { enum: ["icon","title","text","button","link","divider","unknown"] },
            text: { type: "string" },
            caret: { type: "boolean" },
            icon_variant: { enum: ["info","warning","check","unknown"] },
            font: {
              type: "object",
              properties: { size_px:{type:"number"}, weight:{type:"string"}, family_hint:{type:"string"} }
            },
            colors: {
              type: "object",
              properties: { text:{type:"string"}, bg:{type:"string"}, link:{type:"string"}, border:{type:"string"} }
            },
            border: {
              type: "object",
              properties: { width_px:{type:"number"}, style:{type:"string"}, color:{type:"string"}, radius_px:{type:"number"} }
            },
            padding: { type: "object", properties: { t:{type:"number"}, r:{type:"number"}, b:{type:"number"}, l:{type:"number"} } }
          },
          required: ["kind"]
        }
      },
      font: {
        type: "object",
        properties: { family_hint:{type:"string"}, size_px:{type:"number"}, weight:{type:"string"} }
      },
      colors: {
        type: "object",
        properties: { text:{type:"string"}, muted:{type:"string"}, link:{type:"string"}, bg:{type:"string"}, border:{type:"string"}, divider:{type:"string"} }
      },
      border: {
        type: "object",
        properties: { width_px:{type:"number"}, style:{type:"string"}, color:{type:"string"}, radius_px:{type:"number"} }
      },
      padding: { type: "object", properties: { t:{type:"number"}, r:{type:"number"}, b:{type:"number"}, l:{type:"number"} } },
      background: {
        type: "object",
        properties: {
          kind: { enum: ["solid","gradient","transparent"] },
          color: { type: "string" },
          gradient: {
            type: "object",
            properties: { direction:{type:"string"}, stops:{ type:"array", items:{ type:"object", properties:{ color:{type:"string"}, pct:{type:"number"} }, required:["color"] } } }
          }
        }
      },
      shadow: {
        type: "array",
        items: { type:"object", properties:{ x:{type:"number"}, y:{type:"number"}, blur:{type:"number"}, spread:{type:"number"}, rgba:{type:"string"} },
                 required:["x","y","blur","spread","rgba"] }
      }
    },
    required: ["type","font","colors","border","padding","background"]
  };

  const usr = [
    `SCOPE: ${scope}`,
    `COMPONENT HINT: ${component}`,
    "Task: Return ONLY JSON that matches this schema exactly:",
    JSON.stringify(schema),
    "",
    "Guidelines:",
    "- Extract EVERY visible text fragment (title, description, button label, link). Do not summarize.",
    "- If the layout is a banner/container with left copy + right CTA, set type:'banner' and fill `children` in visual order.",
    "- For segmented pills use `type:'segmented'` and `items`.",
    "- If no gradient is visible, set background.kind:'solid'.",
    "- Prefer hex colors."
  ].join("\n");

  const params = isGpt5(useModel)
    ? { max_completion_tokens: 1200 }
    : { max_tokens: 1200, temperature: 0.1 };

  const r = await client.chat.completions.create({
    model: useModel,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: [
          { type:"text", text: usr },
          { type:"image_url", image_url: { url: image, detail: "high" } }
      ] }
    ],
    ...params
  });

  const raw = r?.choices?.[0]?.message?.content || "{}";
  return safeParseJson(raw);
}

/* ---------------- Deterministic codegen ---------------- */

function codegen(spec, opts) {
  const scope = opts?.scope || ".comp";
  const className = getScopeClass(scope);
  const s = normalizeSpec(spec);
  const notes = [];

  // Choose path
  if ((s.type === "banner" || s.type === "container") && s.children?.length) {
    return codegenBanner(s, opts);
  }

  // Previous paths: button, input, segmented, fallback
  const baseFont = `font: ${px(s.font.size_px || 14)}/${1.25} ${s.font.family_hint || 'system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif'};`;
  const textColor = s.colors.text || "#374151";
  const bg = buildBackground(s.background, opts);
  const border = `${px(s.border.width_px || 1)} ${s.border.style || "solid"} ${s.border.color || "#e5e7eb"}`;
  const radius = px(s.border.radius_px || 8);
  const boxShadow = buildShadow(s.shadow);
  const pd = s.padding || {};
  const padding = `${px(pd.t ?? 8)} ${px(pd.r ?? 12)} ${px(pd.b ?? 8)} ${px(pd.l ?? 12)}`;

  let css = "";
  let html = "";

  switch (s.type) {
    case "button": {
      css = `
${scope}{ ${baseFont} color:${textColor}; }
${scope} .btn{
  appearance:none;-webkit-appearance:none;
  display:inline-block;
  ${bg}
  color:${textColor};
  border:${border};
  border-radius:${radius};
  padding:${padding};
  ${boxShadow}
  font-weight:${cssWeight(s.font.weight)};
  text-decoration:none;cursor:pointer;text-align:center;
}
${scope} .btn:hover{ filter:brightness(1.04); }
${scope} .btn:active{ transform:translateY(1px); }
${scope} .btn:focus-visible{ outline:2px solid #93c5fd; outline-offset:2px; }
`.trim();
      const label = s.text || "Button";
      html = `<div class="${className}">\n  <button class="btn">${escapeHtml(label)}</button>\n</div>`;
      break;
    }
    case "input": {
      const inputType = s.html_hint === "input" ? "text" : "text";
      css = `
${scope}{ ${baseFont} color:${textColor}; }
${scope} input[type="${inputType}"]{
  ${bg}
  color:${textColor};
  border:${border};
  border-radius:${radius};
  padding:${padding}; outline:none;
}
${scope} input[type="${inputType}"]:focus{ border-color:${s.colors.border || "#9ca3af"}; box-shadow:0 0 0 3px rgba(59,130,246,.2); }
`.trim();
      html = `<div class="${className}">\n  <input type="${inputType}" placeholder="${escapeHtml(s.text || "Enter text")}">\n</div>`;
      break;
    }
    case "segmented":
    case "chip": {
      const dividerColor = s.colors.divider || s.colors.border || "#e5e7eb";
      const linkColor = s.colors.link || "#2563eb";
      css = `
${scope}{ ${baseFont} color:${textColor}; }
${scope} .chip{ display:inline-flex;align-items:center; border:${border}; border-radius:9999px; background:#fff; padding:2px 6px; }
${scope} .seg{ display:inline-flex;align-items:center;gap:6px; padding:${padding}; border-radius:9999px; color:${textColor}; text-decoration:none; white-space:nowrap; }
${scope} button.seg{ appearance:none;-webkit-appearance:none;background:transparent;border:0;font:inherit;color:inherit;padding:${padding}; }
${scope} .divider{ width:1px;height:18px;margin:0 2px;background:${dividerColor}; }
${scope} .seg.label{ color:${s.colors.muted || "#6b7280"}; }
${scope} .seg.link, ${scope} .seg.value.linky{ color:${linkColor}; }
${scope} .seg.link:hover, ${scope} .seg.value.linky:hover{ color:${shade(linkColor,-10)}; }
${scope} .icon-x{ width:18px;height:18px;border-radius:9999px;border:1px solid ${shade(dividerColor,-10)}; color:${s.colors.muted || "#6b7280"}; display:inline-flex;align-items:center;justify-content:center;font-size:12px;line-height:1;font-weight:600;margin:0 4px 0 2px; }
${scope} .icon-x::before{ content:"×"; }
${scope} .has-caret::after{ content:"▾"; font-size:11px;color:${s.colors.muted || "#6b7280"};margin-left:6px; }
`.trim();

      const parts = [];
      const items = Array.isArray(s.items) ? s.items : [];
      items.forEach((it, i) => {
        if (i>0) parts.push(`<span class="divider"></span>`);
        const careted = it.caret ? " has-caret" : "";
        const linky = it.role === "link" || it.role === "dropdown" || it.role === "value" ? " linky" : "";
        if (it.icon_x) parts.push(`<span class="seg"><span class="icon-x" aria-hidden="true"></span></span>`);
        if (it.role === "label") parts.push(`<span class="seg label">${escapeHtml(it.text || "")}</span>`);
        else if (it.role === "link") parts.push(`<a class="seg link${careted}" href="#">${escapeHtml(it.text || "")}</a>`);
        else parts.push(`<button class="seg value${linky}${careted}">${escapeHtml(it.text || "")}</button>`);
      });

      html = `<div class="${className}">\n  <div class="chip">\n    ${parts.join("\n    ")}\n  </div>\n</div>`;
      break;
    }
    default: {
      // Generic block (fallback)
      css = `
${scope}{ ${baseFont} color:${textColor}; }
${scope} .block{ ${bg} color:${textColor}; border:${border}; border-radius:${radius}; padding:${padding}; ${boxShadow} }
`.trim();
      html = `<div class="${className}">\n  <div class="block">${escapeHtml(s.text || "Component")}</div>\n</div>`;
    }
  }

  return { css, html, notes };
}

/* --- Banner/container with children (icon + title + text + CTA) --- */
function codegenBanner(spec, opts) {
  const scope = opts?.scope || ".comp";
  const className = getScopeClass(scope);
  const s = normalizeSpec(spec);

  const baseFont = `font: ${px(s.font.size_px || 14)}/${1.45} ${s.font.family_hint || 'system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif'};`;
  const textColor = s.colors.text || "#e5e7eb";
  const bg = buildBackground(s.background, opts);
  const border = `${px(s.border.width_px || 1)} ${s.border.style || "solid"} ${s.border.color || "#2f3133"}`;
  const radius = px(s.border.radius_px || 10);
  const boxShadow = buildShadow(s.shadow) || "box-shadow:0 2px 4px rgba(0,0,0,.2);";
  const pd = s.padding || {};
  const padding = `${px(pd.t ?? 16)} ${px(pd.r ?? 16)} ${px(pd.b ?? 16)} ${px(pd.l ?? 16)}`;

  const title = findChildText(s.children, "title") || s.text || "";
  const body  = findChildText(s.children, "text")  || "";
  const btn   = findChildText(s.children, "button") || "Action";
  const hasIcon = !!s.children?.find(c => c.kind === "icon");

  // Button styling (use child's colors if available)
  const btnChild = s.children?.find(c => c.kind === "button") || {};
  const btnBg = colorOr(btnChild.colors?.bg) || "#ffffff";
  const btnText = colorOr(btnChild.colors?.text) || "#111827";
  const btnBorder = colorOr(btnChild.colors?.border) || "#e5e7eb";

  const css = `
${scope}{ ${baseFont} color:${textColor}; }
${scope} .banner{ ${bg} border:${border}; border-radius:${radius}; padding:${padding}; ${boxShadow} }
${scope} .banner-inner{ display:flex; align-items:center; justify-content:space-between; gap:16px; }
${scope} .left{ display:flex; align-items:flex-start; gap:12px; min-width:0; }
${scope} .copy{ min-width:0; }
${scope} .title{ font-weight:700; color:${textColor}; margin:0 0 6px 0; }
${scope} .desc{ color:${textColor}; opacity:.85; }
${scope} .right{ flex:0 0 auto; }
${scope} .btn{
  appearance:none;-webkit-appearance:none;
  background:${btnBg};
  color:${btnText};
  border:1px solid ${btnBorder};
  border-radius:999px;
  padding:8px 14px;
  font-weight:600; cursor:pointer; white-space:nowrap;
}
${scope} .btn:hover{ filter:brightness(1.03); }
${scope} .icon{
  width:18px;height:18px;border-radius:999px;border:1px solid ${shade(s.colors.border || "#3a3a3a", -10)};
  display:inline-grid; place-items:center; color:${textColor}; opacity:.9; font-size:12px; line-height:1;
}
${scope} .icon::before{ content:"i"; font-weight:700; }
`.trim();

  const iconHtml = hasIcon ? `<span class="icon" aria-hidden="true"></span>` : "";

  const html = `
<div class="${className}">
  <div class="banner">
    <div class="banner-inner">
      <div class="left">
        ${iconHtml}
        <div class="copy">
          ${title ? `<div class="title">${escapeHtml(title)}</div>` : ""}
          ${body  ? `<div class="desc">${escapeHtml(body)}</div>` : ""}
        </div>
      </div>
      <div class="right">
        <button class="btn">${escapeHtml(btn)}</button>
      </div>
    </div>
  </div>
</div>`.trim();

  return { css, html, notes: "Composite banner generated." };
}

/* ---------------- Build helpers ---------------- */

function buildBackground(bg, opts) {
  if (!bg || bg.kind === "transparent") return "";
  if (opts?.force_solid) {
    const solid = colorOr(bg.color) || opts.solid_color || "#ffffff";
    return `background-color:${solid};`;
  }
  if (bg.kind === "solid") {
    return `background-color:${colorOr(bg.color) || "#ffffff"};`;
  }
  if (bg.kind === "gradient" && bg.gradient?.stops?.length) {
    const dir = bg.gradient.direction || "to bottom";
    const stops = bg.gradient.stops
      .map(s => `${colorOr(s.color) || "#ffffff"}${typeof s.pct === "number" ? ` ${Math.max(0, Math.min(100, Math.round(s.pct)))}%` : ""}`)
      .join(", ");
    return `background: linear-gradient(${dir}, ${stops});`;
  }
  return `background-color:${colorOr(bg.color) || "#ffffff"};`;
}

function buildShadow(sh) {
  if (!Array.isArray(sh) || !sh.length) return "";
  const layers = sh
    .map(x => `${px(n(x.x))} ${px(n(x.y))} ${px(n(x.blur))} ${px(n(x.spread))} ${rgbaOr(x.rgba) || "rgba(0,0,0,.15)"}`)
    .join(", ");
  return `box-shadow:${layers};`;
}

/* ---------------- Utils ---------------- */

function ensureBaseFontAndResets(css, scope) {
  const rootRe = new RegExp(`${escapeReg(scope)}\\s*\\{[\\s\\S]*?\\}`, "i");
  if (!rootRe.test(css)) {
    css = `${scope}{ font:13px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif; color:#374151; }\n` + css;
  }
  if (/\bbutton\b/i.test(css) && !new RegExp(`${escapeReg(scope)}[\\s\\S]*button[\\s\\S]*appearance`, "i").test(css)) {
    css += `\n${scope} button{appearance:none;-webkit-appearance:none;background:transparent;border:0;font:inherit;color:inherit}`;
  }
  return css;
}

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
  out = out.replace(/,\s*(;|\})/g, "$1");           // trailing commas
  out = out.replace(/([^;\{\}\s])\s*\}/g, "$1; }"); // missing semis
  const open = (out.match(/\{/g) || []).length;
  const close = (out.match(/\}/g) || []).length;
  if (open > close) out += "}".repeat(open - close);
  return out.trim();
}

function cssOnly(text = "") { return String(text).replace(/^```(?:css)?\s*/i, "").replace(/```$/i, "").trim(); }
function htmlOnly(s = "") { return String(s).replace(/^```(?:html)?\s*/i, "").replace(/```$/i, "").trim(); }
function safeParseJson(raw = "{}") {
  try { return JSON.parse(raw); } catch {}
  const m = String(raw).match(/\{[\s\S]*\}$/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return {};
}

function ensureScopedHtml(html, scope) {
  const className = getScopeClass(scope);
  const rootRe = new RegExp(`<([a-z0-9-]+)([^>]*class=["'][^"']*${escapeReg(className)}[^"']*["'][^>]*)>`, "i");
  if (rootRe.test(html)) return htmlOnly(html);
  return `<div class="${className}">\n${htmlOnly(html)}\n</div>`;
}

function normalizeSpec(s = {}) {
  const def = (v, d) => (v === undefined || v === null ? d : v);
  return {
    type: s.type || "unknown",
    text: s.text || "",
    html_hint: s.html_hint || "div",
    items: Array.isArray(s.items) ? s.items : [],
    children: Array.isArray(s.children) ? s.children : [],
    font: {
      family_hint: s.font?.family_hint || 'system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif',
      size_px: def(s.font?.size_px, 14),
      weight: s.font?.weight || "600"
    },
    colors: {
      text: colorOr(s.colors?.text) || "#e5e7eb",
      muted: colorOr(s.colors?.muted) || "#9ca3af",
      link: colorOr(s.colors?.link) || "#60a5fa",
      bg: colorOr(s.colors?.bg) || "#111827",
      border: colorOr(s.colors?.border) || "#2f3133",
      divider: colorOr(s.colors?.divider) || "#2f3133"
    },
    border: {
      width_px: n(s.border?.width_px ?? 1),
      style: s.border?.style || "solid",
      color: colorOr(s.border?.color) || "#2f3133",
      radius_px: n(s.border?.radius_px ?? 10)
    },
    padding: {
      t: n(s.padding?.t ?? 16),
      r: n(s.padding?.r ?? 16),
      b: n(s.padding?.b ?? 16),
      l: n(s.padding?.l ?? 16)
    },
    background: s.background || { kind:"solid", color:"#111827" },
    shadow: Array.isArray(s.shadow) ? s.shadow : []
  };
}

function findChildText(arr, kind) {
  const it = (arr||[]).find(x => x.kind === kind);
  return it?.text || "";
}

/* Tiny helpers */
function n(v){ const x = Number(v); return Number.isFinite(x) ? x : 0; }
function px(v){ return `${Math.max(0, Math.round(Number(v)||0))}px`; }
function colorOr(c){ return (typeof c === "string" && c.trim()) ? c.trim() : ""; }
function rgbaOr(v){ return (typeof v === "string" && /rgba?\(/i.test(v)) ? v : ""; }
function cssWeight(w){ return /^\d+$/.test(w||"") ? w : (String(w||"").toLowerCase().includes("bold") ? "700" : "600"); }
function getScopeClass(scope=".comp"){ return String(scope).trim().replace(/^\./,""); }
function escapeHtml(s=""){ return String(s).replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m])); }
function escapeReg(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function shade(hex,delta){
  let m = (hex||"").match(/^#?([0-9a-f]{6})$/i); if(!m) return hex||"#2563eb";
  let n = parseInt(m[1],16), r=(n>>16)&255,g=(n>>8)&255,b=n&255;
  const adj = (x)=>Math.max(0,Math.min(255, Math.round(x + (delta/100)*255)));
  return "#"+[adj(r),adj(g),adj(b)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
function extractErrMsg(err){
  if (err?.response?.data) { try { return JSON.stringify(err.response.data); } catch {} return String(err.response.data); }
  return String(err?.message || err);
}
function sendError(res, status, error, details){
  const out = { error: String(error || "Unknown") };
  if (details) out.details = String(details);
  res.status(status).json(out);
}
