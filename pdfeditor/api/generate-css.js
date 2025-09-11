// pages/api/generate-css.js
// Image → CSS API (Next.js / Vercel)
// -----------------------------------------------------------------------------
// Goals
// - Generate VALID, SCOPED, COMPONENT-ONLY CSS from a single component screenshot
// - Rock-solid output: markers + extraction + auto-repair (dangling rgba, ,;, braces)
// - Remove stray selector tokens (e.g., a bare ".comp" line)
// - Auto-merge broken multi-line box-shadow/text-shadow declarations
// - Gradient guardrails + client "force_solid" override
// - GPT-5 → mini → 4.x fallbacks, model probe with >=16 tokens
// - Rich error details back to client (no opaque 500s)
// - Input validation + scope sanitization
//
// POST JSON:
// {
//   image: "data:image/...",
//   scope?: ".comp",
//   component?: "button" | "card" | "input" | string,
//   palette?: string[],
//   double_checks?: number,   // critique→fix loops (1..4), default 1 (fast)
//   force_solid?: boolean,    // client hint: flat background (no gradients)
//   solid_color?: string,     // suggested hex if flat, e.g. "#3b82f6"
//   minify?: boolean,         // optional: return minified CSS too
//   debug?: boolean           // if true, include raw_out_preview text
// }
//
// 200 OK Response:
// {
//   draft, css, versions, passes, palette, scope, component, model,
//   notes, diagnostics:{ markersFound, repairs[], scopeWasSanitized },
//   minified?, raw_out_preview? (when debug:true)
// }
// -----------------------------------------------------------------------------

export const config = { api: { bodyParser: false } };

import OpenAI from "openai";

// ---------- Models & token caps ----------
const MODEL_FALLBACKS = [
  "gpt-5",        // primary (if your project has access)
  "gpt-5-mini",   // smaller/faster
  "gpt-4.1-mini",
  "gpt-4o-mini"
];
const MAX_TOKENS_DRAFT = 1400;
const MAX_TOKENS_CRIT  = 800;
const MAX_TOKENS_FIX   = 1600;
const PING_TOKENS      = 32; // >=16 (Responses API minimum)

// ---------- Handler ----------
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Read raw body (we disabled Next bodyParser above)
    let raw = "";
    for await (const chunk of req) raw += chunk;

    let body;
    try { body = JSON.parse(raw || "{}"); }
    catch (e) { return badRequest(res, "Invalid JSON body", e); }

    const {
      image,
      scope: _scope = ".comp",
      component: _component = "component",
      palette = [],
      double_checks = 1,
      force_solid = false,
      solid_color = "",
      minify = false,
      debug = false
    } = body || {};

    // --- Validate input ---
    if (!isDataUrlImage(image)) {
      return badRequest(
        res,
        "Send { image: dataUrl, palette?, scope?, component?, double_checks?, force_solid?, solid_color?, minify?, debug? }"
      );
    }
    if (!process.env.OPENAI_API_KEY) {
      return serverErr(res, "OPENAI_API_KEY not configured");
    }

    const scopeSan = sanitizeScope(_scope);
    const componentSan = String(_component || "component").trim().slice(0, 72) || "component";
    const cycles = Math.max(1, Math.min(Number(double_checks) || 1, 4));

    const diagnostics = {
      markersFound: false,
      repairs: [],
      scopeWasSanitized: scopeSan !== _scope
    };

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = await pickWorkingModel(client, MODEL_FALLBACKS);

    // ---------- DRAFT ----------
    const draftRun = await passDraft(client, model, {
      image,
      palette: Array.isArray(palette) ? palette : [],
      scope: scopeSan,
      component: componentSan,
      force_solid: !!force_solid,
      solid_color: String(solid_color || "")
    });

    const raws = [];
    if (debug) raws.push({ stage: "draft", raw: String(draftRun.raw || "").slice(0, 2000) });

    let draft = extractCssWithMarkers(draftRun.text);
    diagnostics.markersFound = draft !== null;
    if (draft == null) draft = cssOnly(draftRun.text); // fallback if model missed markers

    draft = enforceScope(draft, scopeSan);

    // Strip stray selector tokens before other repairs
    draft = dropStraySelectors(draft);

    const repairedDraft = repairCss(draft);
    const draftRepairs = diffRepairs(draft, repairedDraft);
    diagnostics.repairs.push(...draftRepairs);
    draft = repairedDraft;

    let css = draft;
    const versions = [css];
    let lastCritique = "";

    // Flatten any gradient if client says screenshot is flat
    if (force_solid) {
      const hex = isHexColor(solid_color) ? solid_color : "#cccccc";
      css = solidifyCss(css, hex);
      versions[0] = css;
    }

    // ---------- Optional Critique → Fix ----------
    for (let i = 1; i <= cycles - 1; i++) {
      const critRun = await passCritique(client, model, {
        image, css, palette, scope: scopeSan, component: componentSan, force_solid
      });
      if (debug) raws.push({ stage: `crit_${i}`, raw: String(critRun.raw || "").slice(0, 2000) });

      lastCritique = textOnly(critRun.text || "");

      // FIX
      const fixRun = await passFix(client, model, {
        image, css, critique: lastCritique, palette, scope: scopeSan, component: componentSan, force_solid, solid_color
      });
      if (debug) raws.push({ stage: `fix_${i}`, raw: String(fixRun.raw || "").slice(0, 2000) });

      let fixed = extractCssWithMarkers(fixRun.text);
      if (fixed == null) fixed = cssOnly(fixRun.text);

      fixed = enforceScope(fixed, scopeSan);

      // Strip stray selector tokens again (fix pass can reintroduce)
      fixed = dropStraySelectors(fixed);

      const repairedFixed = repairCss(fixed);
      const fixRepairs = diffRepairs(fixed, repairedFixed);
      diagnostics.repairs.push(...(fixRepairs || []));

      if (force_solid) {
        const hex = isHexColor(solid_color) ? solid_color : "#cccccc";
        fixed = solidifyCss(repairedFixed, hex);
      } else {
        fixed = repairedFixed;
      }

      css = fixed;
      versions.push(css);
    }

    const out = {
      draft,
      css,
      versions,
      passes: 1 + Math.max(0, cycles - 1) * 2,
      palette,
      notes: force_solid ? "Flatness detected → gradients/gloss avoided." : (lastCritique || ""),
      scope: scopeSan,
      component: componentSan,
      model,
      diagnostics
    };

    if (minify) out.minified = minifyCss(css);
    if (debug) {
      out.raw_out_preview = raws
        .map(r => `=== ${r.stage.toUpperCase()} ===\n${r.raw}`)
        .join("\n\n");
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(out);

  } catch (err) {
    console.error("generate-css error:", err);
    const status = Number(err?.status || err?.code || 500);
    const details = err?.error?.message || err?.message || "Unknown error";
    const extra = safeStringify(err?.response?.data || err?.data || err?.cause || null);
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      error: "Failed to generate CSS.",
      details,
      extra
    });
  }
}

// ---------- Small helpers ----------
function badRequest(res, msg, e) {
  return res.status(400).json({ error: "Bad request", details: msg, extra: e ? String(e?.message || e) : undefined });
}
function serverErr(res, msg) {
  return res.status(500).json({ error: msg });
}
function safeStringify(x) { try { return x ? JSON.stringify(x, null, 2) : undefined; } catch { return String(x); } }

function isDataUrlImage(s) {
  return typeof s === "string" && /^data:image\/(png|jpe?g|webp|gif|bmp|x-icon);base64,/.test(s);
}
function isHexColor(s) {
  return typeof s === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s.trim());
}
function sanitizeScope(s) {
  let v = String(s || ".comp").trim();
  if (!v.startsWith(".")) v = "." + v;
  // allow letters, numbers, dash, underscore; single class only
  v = v.replace(/[^a-z0-9\-_]/gi, "");
  if (!v) v = ".comp";
  if (!v.startsWith(".")) v = "." + v;
  return v;
}

function cssOnly(text = "") {
  return String(text).replace(/^```(?:css)?\s*/i, "").replace(/```$/i, "").trim();
}
function textOnly(s = "") {
  return String(s).replace(/```[\s\S]*?```/g, "").trim();
}

/** Extract CSS strictly between markers; return null if missing. */
function extractCssWithMarkers(s = "") {
  const m = String(s).match(/\/\*START_CSS\*\/([\s\S]*?)\/\*END_CSS\*\//);
  return m ? m[1].trim() : null;
}

/** Prefix top-level selectors with the scope (except :root and @rules). */
function enforceScope(inputCss = "", scope = ".comp") {
  let css = inputCss.trim();
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

/** Replace gradients with a solid color & drop glossy ::after overlays */
function solidifyCss(css = "", hex = "#cccccc") {
  const solid = `background-color: ${hex};`;
  return css
    .replace(/background\s*:\s*[^;]*gradient\([^;]*\)\s*;?/gi, solid)
    .replace(/background-image\s*:\s*[^;]*gradient\([^;]*\)\s*;?/gi, "background-image: none;")
    .replace(/::after\s*\{[^}]*\}/gi, (block) => {
      if (/background[^;]*gradient/i.test(block) || /rgba\([^)]*,\s*[^)]*,\s*[^)]*,\s*0(\.\d+)?\)/i.test(block)) return "";
      return block;
    });
}

/** Remove standalone selector tokens (lines w/ no `{`, `}`, or `:`). */
function dropStraySelectors(css = "") {
  const re = /^[ \t]*(?!@)(?!\d+%)(?!from\b)(?!to\b)(?!\/\*)(?!\*)[^:{}\n]+?[ \t]*$/gm;
  return css.replace(re, "").replace(/\n{2,}/g, "\n").trim();
}

/** Attempt to repair common truncations & glitches and return fixed CSS. */
function repairCss(css = "") {
  let out = css;

  // 0) Remove stray markers if they leaked in
  out = out.replace(/\/\*START_CSS\*\/|\/\*END_CSS\*\//g, "");

  // 0b) Remove stray selector tokens (again, in case)
  out = dropStraySelectors(out);

  // 1) Finish dangling rgba(
  out = out.replace(/rgba\(\s*([^)]+)?$/i, (m, inside) => {
    const parts = (inside || "").split(",").map(s => s.trim()).filter(Boolean);
    while (parts.length < 4) parts.push(parts.length < 3 ? "0" : "0.2");
    const [r,g,b,a] = parts.slice(0,4);
    return `rgba(${num(r)}, ${num(g)}, ${num(b)}, ${num(a)})`;
  });

  // 2) Ensure shadow lines end with semicolons (before we merge)
  out = out.replace(/(box-shadow|text-shadow)\s*:[^;{}]+(?=\n|$)/gi, (m) => m + ";");

  // 3) Fix ',;' → ';' and collapse duplicate semicolons
  out = out.replace(/,\s*;/g, ";").replace(/;;+/g, ";");

  // 3b) Remove trailing commas before semicolon in shadow properties
  out = out.replace(/(box-shadow|text-shadow)\s*:\s*([^;{}]+?),\s*;/gi, (m, prop, vals) => {
    return `${prop}: ${vals.trim()};`;
  });

  // 4) Merge multi-line/fragmented shadow values into one comma-separated list
  out = mergeShadowFragments(out, "box-shadow");
  out = mergeShadowFragments(out, "text-shadow");

  // 5) Balance parentheses & braces
  out = balanceParens(out);
  out = balanceBraces(out);

  // 6) Ensure declarations end with semicolon before }
  out = out.replace(/([^;{}\s])\s*}/g, "$1; }");

  // 7) Remove truly empty rule blocks (e.g., ".x:active { }")
  out = out.replace(/(^|})\s*([^{]+)\{\s*}\s*/g, "$1");

  return out.trim();
}

/**
 * Merge broken shadow declarations like:
 *   box-shadow: <a>; <b>;            -> box-shadow: <a>, <b>;
 * Works across newlines/spaces; runs repeatedly until stable.
 */
function mergeShadowFragments(css = "", prop = "box-shadow") {
  let out = css;
  // Pattern: (prop:)( value1 ); ( value2 );
  // Ensure the second part is NOT starting like a property name (e.g., "color:")
  const re = new RegExp(`(${prop}\\s*:\\s*)([^;{}]+);\\s*(?![a-z-]+\\s*:)([^;{}]+);`, "gi");
  let prev;
  do {
    prev = out;
    out = out.replace(re, (_m, head, a, b) => {
      const left = a.trim().replace(/,\s*$/,"");    // strip trailing comma
      const right = b.trim().replace(/^,\s*/,"");   // strip leading comma  <-- fixed
      return `${head}${left}, ${right};`;
    });
  } while (out !== prev);
  return out;
}

function num(v){
  const n = parseFloat(String(v).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}
function balanceParens(s=""){
  let open=0, res="";
  for (const ch of s) {
    if (ch === "(") open++;
    if (ch === ")") open = Math.max(0, open - 1);
    res += ch;
  }
  while (open-- > 0) res += ")";
  return res;
}
function balanceBraces(s=""){
  const opens=(s.match(/{/g)||[]).length, closes=(s.match(/}/g)||[]).length;
  let out=s;
  for (let i=0; i<opens-closes; i++) out += "\n}";
  return out;
}

/** Very light minifier (keeps readability reasonable) */
function minifyCss(css="") {
  return css
    .replace(/\/\*[^*]*\*+([^/*][^*]*\*+)*\//g,"") // comments
    .replace(/\s*([{}:;,])\s+/g,"$1")
    .replace(/\s{2,}/g," ")
    .replace(/;}/g,"}")
    .trim();
}

/** Explain what repairs we applied (for diagnostics) */
function diffRepairs(before, after) {
  const notes = [];
  if (/\/\*START_CSS\*\/|\/\*END_CSS\*\//.test(before) && !/\/\*START_CSS\*\/|\/\*END_CSS\*\//.test(after))
    notes.push("Removed stray START/END markers from CSS.");
  if (/,;/.test(before) && !/,;/.test(after))
    notes.push("Fixed ',;' punctuation.");
  if (/rgba\(\s*[^)]*$/.test(before) && !/rgba\(\s*[^)]*$/.test(after))
    notes.push("Completed dangling rgba(...).");

  // detect shadow merge
  const hadBrokenShadow =
    /(box-shadow|text-shadow)\s*:\s*[^;{}]+;\s*(?![a-z-]+:)[^;{}]+;/.test(before);
  const hasMergedShadow =
    /(box-shadow|text-shadow)\s*:\s*[^;{}]+,\s*[^;{}]+;/.test(after);
  if (hadBrokenShadow && hasMergedShadow) notes.push("Merged fragmented shadow declarations.");

  const bOpen=(before.match(/{/g)||[]).length, bClose=(before.match(/}/g)||[]).length;
  const aOpen=(after.match(/{/g)||[]).length, aClose=(after.match(/}/g)||[]).length;
  if (bOpen !== bClose && aOpen === aClose) notes.push("Balanced unmatched braces.");

  // detect stray selector removal
  if (/^[ \t]*(?!@)(?!\d+%)(?!from\b)(?!to\b)(?!\/\*)(?!\*)[^:{}\n]+?[ \t]*$/m.test(before) &&
      !/^[ \t]*(?!@)(?!\d+%)(?!from\b)(?!to\b)(?!\/\*)(?!\*)[^:{}\n]+?[ \t]*$/m.test(after)) {
    notes.push("Removed stray selector tokens.");
  }

  return notes;
}

// ---------- Model fallback probing ----------
async function pickWorkingModel(client, candidates) {
  let lastErr;
  for (const m of candidates) {
    try {
      const ping = await client.responses.create({
        model: m,
        input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }],
        max_output_tokens: PING_TOKENS
      });
      if (ping?.output_text !== undefined) return m;
    } catch (e) {
      lastErr = e;
      const msg = (e?.message || "").toLowerCase();
      if (msg.includes("does not exist") || msg.includes("you do not have access")) continue;
      throw e; // quota/key/etc.
    }
  }
  throw lastErr || new Error("No working model from fallback list");
}

// ---------- Prompts ----------
function draftSystemPrompt() {
  return [
    "You are a front-end CSS engine. Output VALID vanilla CSS only (no HTML/Markdown).",
    "You are styling a SINGLE UI COMPONENT, not a full page.",
    "All selectors MUST be under the provided SCOPE CLASS.",
    "Do NOT add resets/normalizers or page layout.",
    "Be minimal and faithful to the screenshot of the component.",
    "Gradient rule:",
    "- Only use linear-gradient if a clear gradient is visible.",
    "- If the background appears uniform (flat), use a single background-color.",
    "- Do NOT add glossy overlays (::after) unless the screenshot clearly shows a highlight.",
    "",
    "MANDATORY OUTPUT FORMAT:",
    "Return CSS ONLY and wrap it EXACTLY like this:",
    "/*START_CSS*/",
    "<your CSS here>",
    "/*END_CSS*/"
  ].join("\n");
}
function fixSystemPrompt() {
  return [
    "Return CSS only (no HTML/Markdown). Overwrite the stylesheet to resolve the critique and better match the SINGLE component.",
    "All selectors must remain under the provided scope.",
    "No global selectors or page-level structures.",
    "Gradient rule:",
    "- Only use gradients if they are visually present in the screenshot.",
    "- If caller indicates flat, use a single background-color (no gloss).",
    "",
    "MANDATORY OUTPUT FORMAT:",
    "Return CSS ONLY wrapped EXACTLY like:",
    "/*START_CSS*/",
    "<your CSS here>",
    "/*END_CSS*/"
  ].join("\n");
}

// ---------- Model passes (Responses API) ----------
async function passDraft(client, model, { image, palette, scope, component, force_solid, solid_color }) {
  const sys = draftSystemPrompt();
  const guard = force_solid
    ? [
        "",
        "The caller indicated the screenshot is flat:",
        "- Use a single background-color only.",
        "- Do NOT use gradients or glossy overlays.",
        isHexColor(solid_color) ? `- Prefer this background-color if it matches: ${solid_color}` : ""
      ].join("\n")
    : "";

  const usr = [
    `SCOPE CLASS: ${scope}`,
    `COMPONENT TYPE (hint): ${component}`,
    "Requirements:",
    "- Prefix every selector with the scope (e.g., `.comp .btn`) or use the scope as the root.",
    "- No global selectors (html, body, *). No headers/footers/layout.",
    Array.isArray(palette) && palette.length ? `Optional palette tokens: ${palette.join(", ")}` : "Palette is optional.",
    guard,
    "IMPORTANT: Wrap your CSS between /*START_CSS*/ and /*END_CSS*/ with nothing else outside."
  ].join("\n");

  const resp = await client.responses.create({
    model,
    instructions: sys,
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: usr },
        { type: "input_image", image_url: image } // data URL accepted
      ]
    }],
    max_output_tokens: MAX_TOKENS_DRAFT
  });

  return respToStrings(resp); // { text, raw }
}

async function passCritique(client, model, { image, css, palette, scope, component, force_solid }) {
  const sys = [
    "You are a strict component QA assistant. Output plain text (no CSS).",
    "Compare the screenshot WITH the CURRENT CSS for the SINGLE component.",
    "Identify concrete mismatches (size, spacing, radius, colors, borders, shadows, typography, hover, alignment).",
    "Keep it terse and actionable with target selectors when possible.",
    "Gradient rule:",
    "- Only use gradient if the screenshot clearly shows one.",
    "- If the screenshot looks flat and gradients are present, call that out."
  ].join("\n");

  const guard = force_solid ? "\nCaller indicated flat screenshot → flag any gradient/gloss usage." : "";

  const usr = [
    `SCOPE CLASS: ${scope}`,
    `COMPONENT TYPE (hint): ${component}`,
    "CURRENT CSS:",
    "```css",
    css,
    "```",
    Array.isArray(palette) && palette.length ? `Palette hint: ${palette.join(", ")}` : "",
    guard
  ].join("\n");

  const resp = await client.responses.create({
    model,
    instructions: sys,
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: usr },
        { type: "input_image", image_url: image }
      ]
    }],
    max_output_tokens: MAX_TOKENS_CRIT
  });

  return respToStrings(resp); // { text, raw }
}

async function passFix(client, model, { image, css, critique, palette, scope, component, force_solid, solid_color }) {
  const sys = fixSystemPrompt();
  const guard = force_solid
    ? [
        "",
        "Caller indicated the screenshot is flat →",
        "- Use a single background-color.",
        "- Do NOT use gradients or glossy overlays.",
        isHexColor(solid_color) ? `- Prefer: ${solid_color}` : ""
      ].join("\n")
    : "";

  const usr = [
    `SCOPE CLASS: ${scope}`,
    `COMPONENT TYPE (hint): ${component}`,
    "CRITIQUE:",
    critique || "(none)",
    "",
    "CURRENT CSS:",
    "```css",
    css,
    "```",
    Array.isArray(palette) && palette.length ? `Palette hint (optional): ${palette.join(", ")}` : "",
    guard,
    "IMPORTANT: Wrap your CSS between /*START_CSS*/ and /*END_CSS*/ with nothing else outside."
  ].join("\n");

  const resp = await client.responses.create({
    model,
    instructions: sys,
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: usr },
        { type: "input_image", image_url: image }
      ]
    }],
    max_output_tokens: MAX_TOKENS_FIX
  });

  return respToStrings(resp); // { text, raw }
}

/** Prefer output_text; otherwise stitch 'output' parts into text + return raw */
function respToStrings(resp) {
  const stitched = stitchOutput(resp);
  const text = (typeof resp?.output_text === "string" && resp.output_text.trim().length)
    ? resp.output_text
    : stitched;
  const raw = stitched || resp?.output_text || "";
  return { text, raw };
}

/** Fallback in case output_text is missing; stitch 'output' parts into text. */
function stitchOutput(resp) {
  try {
    const parts = resp?.output || [];
    return parts
      .map(p => {
        if (p?.content && Array.isArray(p.content)) {
          return p.content
            .map(c => (typeof c.text === "string" ? c.text :
                       (Array.isArray(c) && typeof c?.[0]?.text === "string" ? c[0].text : "")))
            .join("");
        }
        return "";
      })
      .join("")
      .trim();
  } catch {
    return "";
  }
}
