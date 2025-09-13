// /api/generate-css.js
// Vision → JSON spec → CSS + HTML (scoped)
// Returns: { css, html, spec, notes, scope, component, used_model }

import OpenAI from "openai";

/* ---- Next.js API config: allow raw body; keep on Node runtime ---- */
export const config = { api: { bodyParser: false } }; // IMPORTANT
export const runtime = "nodejs";
export const maxDuration = 20;

/* ---- Model order & helpers ---- */
const MODEL_ORDER = [
  process.env.OPENAI_MODEL, // optional override
  "gpt-5",
  "gpt-5-mini",
  "gpt-4o",
  "gpt-4o-mini",
].filter(Boolean);

const isGpt5 = (m) => /^gpt-5(\b|-)/i.test(m);
const is4oFamily = (m) => /gpt-4o(?:-mini)?$/i.test(m);

/* ---- Handler ---- */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = await readJson(req);
    const {
      image,
      scope = ".comp",
      component = "component",
      force_solid = false,
      solid_color = "",
      debug = false,
    } = body || {};

    if (!image || typeof image !== "string" || !/^data:image\//i.test(image)) {
      return sendError(res, 400, "Send { image: dataUrl, scope?, component? }");
    }
    if (!process.env.OPENAI_API_KEY) {
      return sendError(res, 500, "OPENAI_API_KEY not configured");
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Pass A: general spec
    let { spec, usedModel } = await fetchSpecWithFallback(client, {
      image, scope, component, forceSegmented: false,
    });

    // Pass B: force segmented layout if we didn’t get groups
    if (!isSegmentedWithGroups(spec)) {
      const forced = await fetchSpecWithFallback(client, {
        image, scope, component, forceSegmented: true,
      }).catch(() => null);
      if (forced?.spec && isSegmentedWithGroups(forced.spec)) {
        spec = forced.spec;
        usedModel = forced.usedModel;
      } else {
        spec = repairSegmented(spec); // heuristic fallback
      }
    }

    // Codegen
    const { css: rawCss, html: rawHtml, notes } = codegen(spec, { scope, force_solid, solid_color });
    let css = enforceScope(rawCss, scope);
    css = prettyCss(autofixCss(css));
    css = ensureBaseFont(css, scope);
    const html = ensureScopedHtml(rawHtml, scope);

    if (!css.trim()) return sendError(res, 502, "Model returned empty CSS spec");

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      css, html, spec, notes, scope, component, used_model: usedModel,
      ...(debug ? { debug: { model_order: MODEL_ORDER } } : {})
    });
  } catch (err) {
    return sendError(res, 500, "Failed to generate CSS.", extractErr(err));
  }
}

/* ---------------- Request parsing ---------------- */

async function readJson(req) {
  // If another middleware has already parsed JSON:
  if (req.body && typeof req.body === "object") return req.body;
  let data = "";
  for await (const chunk of req) data += chunk;
  if (!data) return {};
  try { return JSON.parse(data); }
  catch (e) { throw new Error(`Bad JSON: ${e.message}`); }
}

/* ---------------- Model calls (with fallbacks) ---------------- */

async function fetchSpecWithFallback(client, { image, scope, component, forceSegmented }) {
  let lastErr;
  for (const model of MODEL_ORDER) {
    try {
      const spec = await getStyleSpec(client, model, { image, scope, component, forceSegmented });
      return { spec, usedModel: model };
    } catch (e) {
      lastErr = e;
      // Try next model
    }
  }
  throw lastErr || new Error("No usable model");
}

async function getStyleSpec(client, model, { image, scope, component, forceSegmented }) {
  const schema = baseSchema();
  const baseGuidelines =
    "Return STRICT JSON describing the component(s). " +
    "If you see a pill/segmented control with multiple rounded capsules, return type:'segmented' WITH groups[]. " +
    "Each group corresponds to one rounded capsule. Items are left→right with role/text/caret/icon_x/active. " +
    "Extract EVERY visible text verbatim. No markdown—JSON only.";

  const segmentedGuidelines =
    "You MUST return type:'segmented' with groups[] when 2+ rounded capsules are visible. " +
    "Each group is one capsule; inside, items[] with role/text/caret/icon_x/active.";

  const sys = forceSegmented ? segmentedGuidelines : baseGuidelines;
  const usr = [
    `SCOPE: ${scope}`,
    `COMPONENT HINT: ${component}`,
    "Return ONLY JSON matching this schema:",
    JSON.stringify(schema),
  ].join("\n");

  if (isGpt5(model)) {
    // Responses API (GPT-5 family)
    const r = await client.responses.create({
      model,
      max_output_tokens: 1200,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: `${sys}\n\n${usr}` },
          { type: "input_image", image_url: { url: image, detail: "high" } }
        ]
      }]
    });
    const raw = r?.output_text || "";
    const spec = safeJson(raw);
    if (!spec || typeof spec !== "object") throw new Error("Empty/invalid JSON (responses)");
    return spec;
  }

  if (is4oFamily(model)) {
    // Chat Completions (4o / 4o-mini)
    const r = await client.chat.completions.create({
      model,
      temperature: 0.1,
      max_tokens: 1200,
      messages: [
        { role: "system", content: sys },
        {
          role: "user",
          content: [
            { type: "text", text: usr },
            { type: "image_url", image_url: { url: image, detail: "high" } }
          ]
        }
      ]
    });
    const raw = r?.choices?.[0]?.message?.content || "";
    const spec = safeJson(raw);
    if (!spec || typeof spec !== "object") throw new Error("Empty/invalid JSON (chat)");
    return spec;
  }

  throw new Error(`Model '${model}' unsupported for vision`);
}

/* ---------------- Spec schema & helpers ---------------- */

function baseSchema() {
  return {
    type: "object",
    properties: {
      type: { enum: ["button","input","segmented","chip","badge","link","card","toggle","checkbox","radio","banner","container","unknown"] },
      text: { type: "string" },
      html_hint: { enum: ["button","a","input","div"] },
      groups: {
        type: "array",
        items: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  role: { enum: ["label","value","link","dropdown","action","icon","divider","unknown"] },
                  text: { type: "string" },
                  caret: { type: "boolean" },
                  icon_x: { type: "boolean" },
                  active: { type: "boolean" }
                },
                required: ["role"]
              }
            }
          },
          required: ["items"]
        }
      },
      items: { type: "array", items: { type: "object" } },
      font: { type: "object", properties: { family_hint:{type:"string"}, size_px:{type:"number"}, weight:{type:"string"} } },
      colors: { type: "object", properties: { text:{type:"string"}, muted:{type:"string"}, link:{type:"string"}, bg:{type:"string"}, border:{type:"string"}, divider:{type:"string"} } },
      border: { type: "object", properties: { width_px:{type:"number"}, style:{type:"string"}, color:{type:"string"}, radius_px:{type:"number"} } },
      padding: { type: "object", properties: { t:{type:"number"}, r:{type:"number"}, b:{type:"number"}, l:{type:"number"} } },
      background: {
        type: "object",
        properties: {
          kind: { enum: ["solid","gradient","transparent"] },
          color: { type: "string" },
          gradient: {
            type: "object",
            properties: {
              direction:{type:"string"},
              stops:{ type:"array", items:{ type:"object", properties:{ color:{type:"string"}, pct:{type:"number"} } } }
            }
          }
        }
      },
      shadow: { type: "array", items: { type:"object" } },
      children: { type: "array", items: { type: "object" } }
    },
    required: ["type","font","colors","border","padding","background"]
  };
}

function isSegmentedWithGroups(spec) {
  return spec && (spec.type === "segmented" || spec.type === "chip") && Array.isArray(spec.groups) && spec.groups.length > 0;
}
function repairSegmented(spec) {
  if (!spec || !Array.isArray(spec.items) || spec.items.length === 0) return spec;
  return { ...spec, type: "segmented", groups: [{ items: spec.items.map(x => ({
    role: x.role || "value", text: x.text || "", caret: !!x.caret, icon_x: !!x.icon_x, active: !!x.active
  })) }] };
}

/* ---------------- Codegen (CSS/HTML) ---------------- */

function codegen(spec, opts) {
  const scope = opts?.scope || ".comp";
  const s = normalizeSpec(spec);

  if ((s.type === "segmented" || s.type === "chip") && s.groups?.length) {
    return codegenSegmented(s, opts);
  }
  if (s.type === "banner" || s.type === "container" || s.children?.length) {
    return codegenBanner(s, opts);
  }

  // Button
  if (s.type === "button") {
    const css = `
${scope}{ font:${px(s.font.size_px||14)}/${1.25} ${s.font.family_hint}; color:${s.colors.text}; }
${scope} .btn{
  appearance:none;-webkit-appearance:none;
  display:inline-block; ${backgroundDecl(s.background, opts)}
  color:${s.colors.text}; border:${borderDecl(s.border)}; border-radius:${px(s.border.radius_px)};
  padding:${padDecl(s.padding)}; ${shadowDecl(s.shadow)}
  font-weight:${fontWeight(s.font.weight)}; text-decoration:none; cursor:pointer; text-align:center;
}
${scope} .btn:hover{ filter:brightness(1.04); }
${scope} .btn:active{ transform:translateY(1px); }`.trim();

    const html = `<div class="${cls(scope)}">\n  <button class="btn">${esc(s.text || "Button")}</button>\n</div>`;
    return { css, html, notes: "" };
  }

  // Input
  if (s.type === "input") {
    const css = `
${scope}{ font:${px(s.font.size_px||14)}/${1.25} ${s.font.family_hint}; color:${s.colors.text}; }
${scope} input[type="text"]{
  ${backgroundDecl(s.background, opts)} color:${s.colors.text}; border:${borderDecl(s.border)};
  border-radius:${px(s.border.radius_px)}; padding:${padDecl(s.padding)}; outline:none;
}
${scope} input[type="text"]:focus{ border-color:${s.colors.border}; box-shadow:0 0 0 3px rgba(59,130,246,.2); }`.trim();

    const html = `<div class="${cls(scope)}">\n  <input type="text" placeholder="${esc(s.text || "Enter text")}">\n</div>`;
    return { css, html, notes: "" };
  }

  // Generic block
  const css = `
${scope}{ font:${px(s.font.size_px||14)}/${1.25} ${s.font.family_hint}; color:${s.colors.text}; }
${scope} .block{ ${backgroundDecl(s.background, opts)} color:${s.colors.text}; border:${borderDecl(s.border)}; border-radius:${px(s.border.radius_px)}; padding:${padDecl(s.padding)}; ${shadowDecl(s.shadow)} }`.trim();

  const html = `<div class="${cls(scope)}">\n  <div class="block">${esc(s.text || "Component")}</div>\n</div>`;
  return { css, html, notes: "Fallback container." };
}

/* segmented groups */
function codegenSegmented(s, opts) {
  const scope = opts?.scope || ".comp";
  const divider = s.colors.divider || s.colors.border;

  const css = `
${scope}{ font:${px(s.font.size_px||14)}/${1.25} ${s.font.family_hint}; color:${s.colors.text}; display:flex; gap:12px; }
${scope} .chip{ display:inline-flex;align-items:center; border:${borderDecl(s.border)}; border-radius:9999px; background:#fff; padding:2px 6px; }
${scope} .seg{ display:inline-flex;align-items:center;gap:6px; padding:${padDecl(s.padding)}; border-radius:9999px; color:${s.colors.text}; text-decoration:none; white-space:nowrap; }
${scope} button.seg{ appearance:none;-webkit-appearance:none;background:transparent;border:0;font:inherit;color:inherit;padding:${padDecl(s.padding)}; cursor:pointer; }
${scope} .divider{ width:1px;height:18px;margin:0 2px;background:${divider}; }
${scope} .seg.label{ color:${s.colors.muted}; }
${scope} .seg.link, ${scope} .seg.value.linky{ color:${s.colors.link}; }
${scope} .seg.link:hover, ${scope} .seg.value.linky:hover{ color:${tint(s.colors.link,-10)}; }
${scope} .icon-x{ width:18px;height:18px;border-radius:9999px;border:1px solid ${tint(divider,-10)}; color:${s.colors.muted}; display:inline-flex;align-items:center;justify-content:center;font-size:12px;line-height:1;font-weight:600;margin:0 4px 0 2px; }
${scope} .icon-x::before{ content:"×"; }
${scope} .has-caret::after{ content:"▾"; font-size:11px;color:${s.colors.muted};margin-left:6px; }`.trim();

  const chips = (s.groups || []).map(g => {
    const parts = [];
    (g.items || []).forEach((it, i) => {
      if (i>0) parts.push(`<span class="divider"></span>`);
      const careted = it.caret ? " has-caret" : "";
      const linky = (it.role === "link" || it.role === "dropdown" || it.role === "value") ? " linky" : "";
      if (it.icon_x) parts.push(`<span class="seg"><span class="icon-x" aria-hidden="true"></span></span>`);
      if (it.role === "label") parts.push(`<span class="seg label">${esc(it.text || "")}</span>`);
      else if (it.role === "link") parts.push(`<a class="seg link${careted}" href="#">${esc(it.text || "")}</a>`);
      else parts.push(`<button class="seg value${linky}${careted}">${esc(it.text || "")}</button>`);
    });
    return `  <div class="chip">\n    ${parts.join("\n    ")}\n  </div>`;
  });

  const html = `<div class="${cls(scope)}">\n${chips.join("\n")}\n</div>`;
  return { css, html, notes: "Segmented groups generated." };
}

/* banner/container */
function codegenBanner(s, opts) {
  const scope = opts?.scope || ".comp";
  const btnBg = s.children?.find(c => c.kind === "button")?.colors?.bg || "#fff";
  const btnText = s.children?.find(c => c.kind === "button")?.colors?.text || "#111827";
  const btnBorder = s.children?.find(c => c.kind === "button")?.colors?.border || "#e5e7eb";

  const css = `
${scope}{ font:${px(s.font.size_px||14)}/${1.45} ${s.font.family_hint}; color:${s.colors.text}; }
${scope} .banner{ ${backgroundDecl(s.background, opts)} border:${borderDecl(s.border)}; border-radius:${px(s.border.radius_px)}; padding:${padDecl(s.padding)}; ${shadowDecl(s.shadow) || "box-shadow:0 2px 4px rgba(0,0,0,.2);"} }
${scope} .banner-inner{ display:flex; align-items:center; justify-content:space-between; gap:16px; }
${scope} .left{ display:flex; align-items:flex-start; gap:12px; min-width:0; }
${scope} .copy{ min-width:0; }
${scope} .title{ font-weight:700; color:${s.colors.text}; margin:0 0 6px; }
${scope} .desc{ color:${s.colors.text}; opacity:.85; }
${scope} .right{ flex:0 0 auto; }
${scope} .btn{ appearance:none;-webkit-appearance:none; background:${btnBg}; color:${btnText}; border:1px solid ${btnBorder}; border-radius:999px; padding:8px 14px; font-weight:600; cursor:pointer; white-space:nowrap; }`.trim();

  const title = findChildText(s.children, "title") || s.text || "";
  const body  = findChildText(s.children, "text")  || "";
  const btn   = findChildText(s.children, "button") || "Action";
  const icon  = s.children?.find(c => c.kind === "icon");

  const iconHtml = icon ? `<span class="icon" aria-hidden="true" style="width:18px;height:18px;border-radius:999px;border:1px solid ${tint(s.colors.border,-10)};display:inline-grid;place-items:center;color:${s.colors.text};opacity:.9;font-size:12px;line-height:1;font-weight:700;">i</span>` : "";

  const html = `
<div class="${cls(scope)}">
  <div class="banner">
    <div class="banner-inner">
      <div class="left">
        ${iconHtml}
        <div class="copy">
          ${title ? `<div class="title">${esc(title)}</div>` : ""}
          ${body  ? `<div class="desc">${esc(body)}</div>` : ""}
        </div>
      </div>
      <div class="right">
        <button class="btn">${esc(btn)}</button>
      </div>
    </div>
  </div>
</div>`.trim();

  return { css, html, notes: "Composite banner generated." };
}

/* ---------------- Utilities ---------------- */

function safeJson(raw="{}"){ try{ return JSON.parse(raw); }catch{} const m=String(raw).match(/\{[\s\S]*\}$/); if(m){ try{ return JSON.parse(m[0]); }catch{} } return {}; }
function ensureBaseFont(css, scope){ const re=new RegExp(`${escapeReg(scope)}\\s*\\{`,"i"); if(!re.test(css)){ css = `${scope}{ font:13px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif; color:#374151; }\n` + css; } return css; }
function enforceScope(css="", scope=".comp"){ let out=cssOnly(css); out=out.replace(/(^|})\s*([^@}{]+?)\s*\{/g,(m,p1,sel)=>`${p1} ${sel.split(",").map(s=>s.trim().startsWith(scope)||s.trim().startsWith(":root")?s.trim():`${scope} ${s.trim()}`).join(", ")} {`); return out.trim(); }
function autofixCss(css=""){ let out=cssOnly(css); out=out.replace(/,\s*(;|\})/g,"$1"); out=out.replace(/([^;\{\}\s])\s*\}/g,"$1; }"); const a=(out.match(/\{/g)||[]).length,b=(out.match(/\}/g)||[]).length; if(a>b) out+="}".repeat(a-b); return out.trim(); }
function prettyCss(css){ return css.replace(/\}\s*/g,"}\n").replace(/\{\s*/g,"{\n  ").replace(/;\s*/g,";\n  ").replace(/\n\s*\n/g,"\n").trim(); }
function cssOnly(t=""){ return String(t).replace(/^```(?:css)?\s*/i,"").replace(/```$/i,"").trim(); }
function htmlOnly(s=""){ return String(s).replace(/^```(?:html)?\s*/i,"").replace(/```$/i,"").trim(); }
function ensureScopedHtml(html, scope){ const k=cls(scope); const re=new RegExp(`<([a-z0-9-]+)([^>]*class=["'][^"']*${escapeReg(k)}[^"']*["'][^>]*)>`, "i"); if (re.test(html)) return htmlOnly(html); const inner = htmlOnly(html) || `<div class="block">Component</div>`; return `<div class="${k}">\n${inner}\n</div>`; }
function normalizeSpec(s={}){ const d=(v,u)=>v==null?u:v; return {
  type: s.type||"unknown", text:s.text||"", html_hint:s.html_hint||"div",
  items: Array.isArray(s.items)?s.items:[], groups:Array.isArray(s.groups)?s.groups:[], children:Array.isArray(s.children)?s.children:[],
  font:{ family_hint:s.font?.family_hint||'system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif', size_px:d(s.font?.size_px,14), weight:s.font?.weight||"600" },
  colors:{ text:s.colors?.text||"#374151", muted:s.colors?.muted||"#6b7280", link:s.colors?.link||"#2563eb", bg:s.colors?.bg||"#ffffff", border:s.colors?.border||"#e5e7eb", divider:s.colors?.divider||s.colors?.border||"#e5e7eb" },
  border:{ width_px:d(s.border?.width_px,1), style:s.border?.style||"solid", color:s.border?.color||"#e5e7eb", radius_px:d(s.border?.radius_px,18) },
  padding:{ t:d(s.padding?.t,6), r:d(s.padding?.r,10), b:d(s.padding?.b,6), l:d(s.padding?.l,10) },
  background:s.background||{kind:"solid", color:"#ffffff"},
  shadow:Array.isArray(s.shadow)?s.shadow:[]
}; }
function backgroundDecl(bg, opts){ if(!bg||bg.kind==="transparent") return ""; if(opts?.force_solid){ const c=bg.color||opts.solid_color||"#ffffff"; return `background-color:${c};`; } if(bg.kind==="solid") return `background-color:${bg.color||"#ffffff"};`; if(bg.kind==="gradient"&&bg.gradient?.stops?.length){ const dir=bg.gradient.direction||"to bottom"; const stops=bg.gradient.stops.map(s=>`${s.color}${typeof s.pct==="number"?` ${Math.max(0,Math.min(100,Math.round(s.pct)))}%`:""}`).join(", "); return `background: linear-gradient(${dir}, ${stops});`; } return `background-color:${bg.color||"#ffffff"};`; }
function borderDecl(b){ return `${px(b.width_px)} ${b.style} ${b.color}`; }
function padDecl(p){ return `${px(p.t)} ${px(p.r)} ${px(p.b)} ${px(p.l)}`; }
function shadowDecl(sh){ if(!Array.isArray(sh)||!sh.length) return ""; const layers=sh.map(x=>`${px(n(x.x))} ${px(n(x.y))} ${px(n(x.blur))} ${px(n(x.spread))} ${x.rgba||"rgba(0,0,0,.15)"}`).join(", "); return `box-shadow:${layers};`; }
function findChildText(arr, kind){ return (arr||[]).find(x=>x.kind===kind)?.text || ""; }
function n(v){ const x=Number(v); return Number.isFinite(x)?x:0; }
function px(v){ return `${Math.max(0,Math.round(Number(v)||0))}px`; }
function fontWeight(w){ return /^\d+$/.test(w||"")?w:(String(w||"").toLowerCase().includes("bold")?"700":"600"); }
function tint(hex,delta){ const m=(hex||"").match(/^#?([0-9a-f]{6})$/i); if(!m) return hex||"#2563eb"; let N=parseInt(m[1],16), r=(N>>16)&255,g=(N>>8)&255,b=N&255; const adj=x=>Math.max(0,Math.min(255,Math.round(x+(delta/100)*255))); return "#"+[adj(r),adj(g),adj(b)].map(x=>x.toString(16).padStart(2,"0")).join(""); }
function esc(s=""){ return String(s).replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m])); }
function cls(scope){ return String(scope).replace(/^\./,""); }
function escapeReg(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"); }
function extractErr(e){ try{ if (e?.response?.data) return JSON.stringify(e.response.data); }catch{} return String(e?.message||e); }
function sendError(res, status, error, details){ const out={ error:String(error||"Unknown") }; if(details) out.details=String(details); res.status(status).json(out); }
