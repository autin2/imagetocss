// /api/generate-css.js
// CSS-only, component-scoped generator with critique→fix loops and strong error reporting.
// Response: { draft, css, versions, passes, palette, notes, scope, component }
// Supports optional force_solid/solid_color and simple minify/autofix.

import OpenAI from "openai";

const FALLBACK_MODELS = [
  process.env.OPENAI_MODEL,   // user override
  "gpt-5.1-mini",             // prefer 5.x mini if available on your account
  "gpt-4o-mini",              // safe default with vision
].filter(Boolean);

const DEFAULT_MODEL = FALLBACK_MODELS[0] || "gpt-4o-mini";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed", details: "Use POST /api/generate-css" });
    }

    // --- body parsing that works on Vercel/Node streams ---
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch (e) {
      return sendError(res, 400, "Bad JSON", e?.message, "Send application/json with a valid object.");
    }

    const {
      image,
      palette = [],
      double_checks = 1,     // 1–8
      scope = ".comp",
      component = "component",
      force_solid = false,
      solid_color = "",
      minify = false,
      debug = false
    } = body;

    if (!image || typeof image !== "string" || !/^data:image\//i.test(image)) {
      return sendError(res, 400, "Invalid 'image'", "Expected a data URL (data:image/*;base64,...).");
    }
    if (!process.env.OPENAI_API_KEY) {
      return sendError(res, 500, "OPENAI_API_KEY not configured", "Add OPENAI_API_KEY to your environment.");
    }

    const cycles = Math.max(1, Math.min(Number(double_checks) || 1, 8));
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Try preferred model with fallback
    const { model, call } = makeOpenAI(client);

    // ---------- DRAFT ----------
    let draft = await call("draft", {
      model,
      image,
      palette,
      scope,
      component,
    });

    draft = enforceScope(draft, scope);
    let css = draft;
    const versions = [draft];
    let lastCritique = "";

    // ---------- CRITIQUE→FIX cycles ----------
    for (let i = 1; i <= cycles; i++) {
      lastCritique = await call("critique", {
        model,
        image,
        css,
        palette,
        scope,
        component,
        cycle: i,
        total: cycles
      });

      let fixed = await call("fix", {
        model,
        image,
        css,
        critique: lastCritique,
        palette,
        scope,
        component,
        cycle: i,
        total: cycles
      });

      fixed = enforceScope(fixed, scope);
      css = fixed;
      versions.push(css);
    }

    // ---------- post-processing ----------
    css = cssOnly(css);
    css = autofixCss(css);
    if (force_solid) css = flattenGradients(css, solid_color);
    if (minify) css = minifyCss(css);

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      draft,
      css,
      versions,
      passes: 1 + cycles * 2,
      palette,
      notes: lastCritique,
      scope,
      component
    });
  } catch (err) {
    return sendError(res, 500, "Failed to generate CSS.", extractErrMsg(err), "Check server logs for stack trace.");
  }
}

/* ===================== utilities ===================== */

function sendError(res, status, error, details, hint) {
  const payload = { error: String(error || "Unknown") };
  if (details) payload.details = String(details);
  if (hint) payload.hint = String(hint);
  res.status(status).json(payload);
}

function extractErrMsg(err) {
  // OpenAI SDK usually attaches response data here
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

/** Enforce scope: prefix all non-@ rules (except :root) with the scope class. */
function enforceScope(inputCss = "", scope = ".comp") {
  let css = cssOnly(inputCss);
  css = css.replace(/(^|})\s*([^@}{]+?)\s*\{/g, (m, p1, selectors) => {
    const scoped = selectors
      .split(",")
      .map(s => s.trim())
      .map(sel => {
        if (!sel || sel.startsWith(scope) || sel.startsWith(":root")) return sel;
        return `${scope} ${sel}`;
      })
      .join(", ");
    return `${p1} ${scoped} {`;
  });
  return css.trim();
}

/** Remove common model glitches and make CSS parseable. */
function autofixCss(css = "") {
  let out = cssOnly(css);

  // Remove accidental comments tokens or markers
  out = out.replace(/\/\*+\s*START_CSS\s*\*+\//gi, "");

  // Remove stray trailing commas before semicolons/braces
  out = out.replace(/,\s*(;|\})/g, "$1");

  // Remove empty shadow layers: rgba(..., 0)
  out = out.replace(/(box-shadow\s*:\s*)([^;]+);/gi, (m, p, val) => {
    const cleaned = val
      .split(/\s*,\s*/)
      .filter(layer => !/rgba?\([^)]*,\s*0(?:\.0+)?\)/i.test(layer))
      .join(", ");
    return `${p}${cleaned};`;
  });

  // Ensure each declaration ends with a semicolon
  out = out.replace(/([^;\{\}\s])\s*\}/g, "$1; }");

  // Balance braces (best-effort)
  const open = (out.match(/\{/g) || []).length;
  const close = (out.match(/\}/g) || []).length;
  if (open > close) out += "}".repeat(open - close);

  return out.trim();
}

/** Replace linear-gradient backgrounds with a solid if requested. */
function flattenGradients(css = "", solid = "") {
  const color = solid && /^#|rgb|hsl|var\(/i.test(solid) ? solid : null;
  return css.replace(/background(?:-image)?:\s*linear-gradient\([^;]+;\s*/gi, (m) => {
    return color ? `background-color: ${color};` : m;
  });
}

/** Tiny minifier (keeps it readable-ish). */
function minifyCss(css = "") {
  return css
    .replace(/\s*\/\*[\s\S]*?\*\/\s*/g, "")
    .replace(/\s*([\{\}:;,])\s*/g, "$1")
    .replace(/;}/g, "}")
    .trim();
}

/* ===================== OpenAI call adapters ===================== */

/**
 * We use Chat Completions (vision) for reliability.
 * If your account has GPT-5.1-mini, it will work with images via chat;
 * otherwise we fall back to gpt-4o-mini automatically.
 */
function makeOpenAI(client) {
  async function tryModels(run) {
    let lastErr;
    for (const mdl of FALLBACK_MODELS.length ? FALLBACK_MODELS : [DEFAULT_MODEL]) {
      if (!mdl) continue;
      try {
        return { model: mdl, data: await run(mdl) };
      } catch (e) {
        lastErr = e;
        // If model doesn't exist or is restricted, try the next one
        if (String(e?.message || "").includes("does not exist") ||
            String(e?.message || "").includes("restricted") ||
            e?.status === 404) {
          continue;
        }
        throw e;
      }
    }
    throw lastErr || new Error("No usable model found");
  }

  const call = async (kind, args) => {
    const { model } = await tryModels(async (mdl) => ({ ok: true }));

    const sysDraft =
      "You are a front-end CSS engine. Output VALID vanilla CSS only (no HTML/Markdown). " +
      "You are styling a SINGLE UI COMPONENT (not a full page). " +
      "All selectors MUST be scoped under the provided SCOPE CLASS. " +
      "Do NOT target html/body/universal selectors or add resets/normalizers. " +
      "Keep styles minimal and faithful to the screenshot of the component.";

    const sysCrit =
      "You are a strict component QA assistant. Do NOT output CSS. " +
      "Compare the screenshot WITH the CURRENT component CSS. " +
      "Identify concrete mismatches (alignment, spacing, radius, borders, colors, size, typography, hover). " +
      "Ensure selectors remain under the provided scope. Be terse.";

    const sysFix =
      "Return CSS only (no HTML/Markdown). Overwrite the stylesheet to resolve the critique " +
      "and better match the screenshot of the SINGLE COMPONENT. " +
      "All selectors must remain under the provided scope. No global resets.";

    if (kind === "draft") {
      const usr =
        [
          `SCOPE CLASS: ${args.scope}`,
          `COMPONENT TYPE (hint): ${args.component}`,
          "Task: study the screenshot region and produce CSS for ONLY that component.",
          "Requirements:",
          "- Prefix all selectors with the scope (e.g., `.comp .btn`), or use the scope as the root.",
          "- No global resets. No page layout. No headers/footers/cookie banners.",
          "- You MAY expose :root tokens if clearly needed.",
          args.palette?.length ? `Optional palette tokens: ${args.palette.join(", ")}` : "Palette is optional.",
          "Return CSS ONLY."
        ].join("\n");

      const r = await client.chat.completions.create({
        model,
        temperature: 0.2,
        max_tokens: 1200,
        messages: [
          { role: "system", content: sysDraft },
          {
            role: "user",
            content: [
              { type: "text", text: usr },
              { type: "image_url", image_url: { url: args.image } }
            ]
          }
        ]
      });
      return cssOnly(r?.choices?.[0]?.message?.content || "");
    }

    if (kind === "critique") {
      const usr =
        [
          `Critique ${args.cycle}/${args.total} (component-level only).`,
          `SCOPE CLASS: ${args.scope}`,
          `COMPONENT TYPE (hint): ${args.component}`,
          "List actionable corrections with target selectors when possible.",
          "",
          "CURRENT CSS:",
          "```css",
          args.css,
          "```",
          args.palette?.length ? `Palette hint: ${args.palette.join(", ")}` : ""
        ].join("\n");

      const r = await client.chat.completions.create({
        model,
        temperature: 0.0,
        max_tokens: 700,
        messages: [
          { role: "system", content: sysCrit },
          {
            role: "user",
            content: [
              { type: "text", text: usr },
              { type: "image_url", image_url: { url: args.image } }
            ]
          }
        ]
      });
      return textOnly(r?.choices?.[0]?.message?.content || "");
    }

    if (kind === "fix") {
      const usr =
        [
          `Fix ${args.cycle}/${args.total} for the component.`,
          `SCOPE CLASS: ${args.scope}`,
          `COMPONENT TYPE (hint): ${args.component}`,
          "Rules:",
          "- Keep all selectors under the scope.",
          "- No body/html/universal selectors. No page-level structures.",
          "- Adjust alignment, spacing, borders, radius, colors, typography, hover to match the screenshot.",
          "",
          "CRITIQUE:",
          args.critique || "(none)",
          "",
          "CURRENT CSS:",
          "```css",
          args.css,
          "```",
          args.palette?.length ? `Palette hint (optional): ${args.palette.join(", ")}` : ""
        ].join("\n");

      const r = await client.chat.completions.create({
        model,
        temperature: 0.1,
        max_tokens: 1400,
        messages: [
          { role: "system", content: sysFix },
          {
            role: "user",
            content: [
              { type: "text", text: usr },
              { type: "image_url", image_url: { url: args.image } }
            ]
          }
        ]
      });
      return cssOnly(r?.choices?.[0]?.message?.content || args.css);
    }

    throw new Error(`Unknown call kind: ${kind}`);
  };

  return { model: DEFAULT_MODEL, call };
}
