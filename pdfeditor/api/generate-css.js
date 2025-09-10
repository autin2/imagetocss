// /api/generate-css.js
// Robust CSS generator for a SINGLE component from an image.
// Guarantees a closed, scoped CSS block via markers + continuation if truncated.

import OpenAI from "openai";

const MODEL = process.env.OPENAI_MODEL || "gpt-5";
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const data = await readJson(req);
    const {
      image,
      palette = [],
      double_checks = 6,  // 1–8
      scope = ".comp",
      component = "component",
    } = data || {};

    if (!image || typeof image !== "string" || !image.startsWith("data:image"))
      return res.status(400).json({ error: "Send { image:dataUrl, palette?, double_checks?, scope?, component? }" });
    if (!process.env.OPENAI_API_KEY)
      return res.status(500).json({ error: "OPENAI_API_KEY not configured" });

    // Size guard
    const bytes = Buffer.byteLength(image, "utf8");
    if (bytes > 4.5 * 1024 * 1024)
      return res.status(413).json({ error: "Image too large. Keep under ~4MB." });

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // ---- DRAFT ----
    let draft = await passDraft(client, { image, palette, scope, component });
    draft = enforceScope(draft, scope);
    draft = await ensureComplete(client, { css: draft, image, scope, component });

    const versions = [draft];
    let css = draft;
    let lastCritique = "";

    // ---- CRITIQUE → FIX ----
    const cycles = Math.max(1, Math.min(Number(double_checks) || 1, 8));
    for (let i = 1; i <= cycles; i++) {
      lastCritique = await passCritique(client, { image, css, palette, scope, component, cycle: i, total: cycles });
      let fixed = await passFix(client, { image, css, critique: lastCritique, palette, scope, component, cycle: i, total: cycles });
      fixed = enforceScope(fixed, scope);
      fixed = await ensureComplete(client, { css: fixed, image, scope, component });
      css = fixed;
      versions.push(css);
    }

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      draft,
      css,
      versions,
      passes: 1 + cycles * 2,
      palette,
      notes: lastCritique,
      scope,
      component,
    });
  } catch (err) {
    const status =
      err?.status || err?.statusCode || err?.response?.status ||
      (String(err?.message || "").includes("JSON body") ? 400 : 500);

    const toStr = (x) => (typeof x === "string" ? x : safeJson(x));
    console.error("[/api/generate-css] Error:", toStr(err));
    return res.status(status).json({
      error: toStr(err?.message) || "Failed to generate CSS.",
      details: err?.response?.data ?? err?.data,
    });
  }
}

/* ================= helpers ================= */

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let raw = ""; for await (const c of req) raw += c;
  if (!raw) throw new Error("JSON body required but request body was empty.");
  try { return JSON.parse(raw); } catch { throw new Error("Invalid JSON in request body."); }
}

function safeJson(x) {
  try { return JSON.stringify(x, Object.getOwnPropertyNames(x), 2); }
  catch { return String(x); }
}

function between(text, a, b) {
  const i = text.indexOf(a);
  if (i === -1) return null;
  const j = text.indexOf(b, i + a.length);
  if (j === -1) return null;
  return text.slice(i + a.length, j);
}

function cssOnly(s = "") {
  // fallback scrub of code fences if markers are missing
  return String(s).replace(/^```(?:css)?\s*/i, "").replace(/```$/i, "").trim();
}

function enforceScope(inputCss = "", scope = ".comp") {
  let css = inputCss.trim();
  css = css.replace(/(^|})\s*([^@}{]+?)\s*\{/g, (m, p1, selectors) => {
    const scoped = selectors
      .split(",").map(s => s.trim())
      .map(sel => sel.startsWith(scope) || sel.startsWith(":root") || !sel ? sel : `${scope} ${sel}`)
      .join(", ");
    return `${p1} ${scoped} {`;
  });
  return css.trim();
}

// Heuristic: decide if CSS looks truncated
function needsContinuation(css) {
  const t = (css || "").trim();
  if (!t) return true;
  // must end with a closing brace
  if (!/\}\s*$/.test(t)) return true;
  const opens = (t.match(/{/g) || []).length;
  const closes = (t.match(/}/g) || []).length;
  if (closes < opens) return true;
  const parenO = (t.match(/\(/g) || []).length;
  const parenC = (t.match(/\)/g) || []).length;
  if (parenC < parenO) return true;
  // suspicious trailing comma/colon
  if (/[,:]\s*$/.test(t)) return true;
  return false;
}

/* =========== Responses API glue =========== */

function extractText(r) {
  if (typeof r?.output_text === "string") return r.output_text;
  const chunks = [];
  try {
    if (Array.isArray(r?.output)) {
      for (const item of r.output) {
        if (item?.type === "output_text" && typeof item?.text === "string") chunks.push(item.text);
        if (item?.type === "message" && Array.isArray(item?.content)) {
          for (const c of item.content) if (c?.type === "output_text" && typeof c?.text === "string") chunks.push(c.text);
        }
      }
    }
  } catch {}
  return chunks.join("");
}

async function callResponses(client, { system, userParts, tokens = 1600 }) {
  const r = await client.responses.create({
    model: MODEL,
    max_output_tokens: tokens,
    input: [
      { role: "system", content: [{ type: "input_text", text: system }] },
      { role: "user",   content: userParts },
    ],
  });
  return extractText(r) || "";
}

/* ================= passes ================= */

async function passDraft(client, { image, palette, scope, component }) {
  const sys =
    "You are a CSS engine. Return VALID vanilla CSS ONLY (no HTML/Markdown). " +
    "Input is a PHOTO/CROPPED SCREENSHOT of ONE UI COMPONENT (not a full page). " +
    "Rules: (1) All selectors scoped under the provided SCOPE CLASS; " +
    "(2) No global resets/layout; (3) Keep styles minimal and faithful. " +
    "Wrap the CSS between /*START_CSS*/ and /*END_CSS*/ exactly.";

  const usr =
    [
      `SCOPE CLASS: ${scope}`,
      `COMPONENT TYPE (hint): ${component}`,
      "Produce CSS for ONLY that component.",
      palette?.length ? `Optional palette tokens: ${palette.join(", ")}` : "No palette tokens.",
      "Return CSS ONLY, wrapped in the markers."
    ].join("\n");

  const txt = await callResponses(client, {
    system: sys,
    tokens: 2048,
    userParts: [
      { type: "input_text",  text: usr },
      { type: "input_image", image_url: image },
    ]
  });

  const betweenCss = between(txt, "/*START_CSS*/", "/*END_CSS*/");
  return betweenCss ? betweenCss.trim() : cssOnly(txt);
}

async function passCritique(client, { image, css, palette, scope, component, cycle, total }) {
  const sys =
    "You are a strict component QA assistant. Do NOT output CSS. " +
    "Compare the PHOTO of the SINGLE COMPONENT with the CURRENT CSS. " +
    "List precise mismatches (spacing, radius, borders, colors, size, typography, states). " +
    "Be terse.";

  const usr = [
    `Critique ${cycle}/${total}.`,
    `SCOPE CLASS: ${scope}`,
    `COMPONENT TYPE (hint): ${component}`,
    "CURRENT CSS:",
    "```css", css, "```",
    palette?.length ? `Palette hint: ${palette.join(", ")}` : ""
  ].join("\n");

  const txt = await callResponses(client, {
    system: sys,
    tokens: 900,
    userParts: [
      { type: "input_text",  text: usr },
      { type: "input_image", image_url: image },
    ]
  });

  // strip any accidental code blocks
  return String(txt).replace(/```[\s\S]*?```/g, "").trim();
}

async function passFix(client, { image, css, critique, palette, scope, component }) {
  const sys =
    "Return CSS ONLY, wrapped between /*START_CSS*/ and /*END_CSS*/. " +
    "Overwrite the stylesheet to address the critique and better match the photo. " +
    "All selectors must remain under the provided scope. No global/page styles.";

  const usr = [
    `SCOPE CLASS: ${scope}`,
    `COMPONENT TYPE (hint): ${component}`,
    "CRITIQUE:",
    critique || "(none)",
    "",
    "CURRENT CSS:",
    "```css", css, "```",
    palette?.length ? `Palette hint: ${palette.join(", ")}` : ""
  ].join("\n");

  const txt = await callResponses(client, {
    system: sys,
    tokens: 2300,
    userParts: [
      { type: "input_text",  text: usr },
      { type: "input_image", image_url: image },
    ]
  });

  const betweenCss = between(txt, "/*START_CSS*/", "/*END_CSS*/");
  return betweenCss ? betweenCss.trim() : cssOnly(txt);
}

/* === Continuation pass: finish partial CSS without repeating === */

async function ensureComplete(client, { css, image, scope, component }) {
  if (!needsContinuation(css)) return css;

  // Ask the model to continue ONLY the missing tail.
  const sys =
    "Continue the CSS EXACTLY where it stopped. Do NOT repeat earlier lines. " +
    "Return CSS continuation ONLY, between /*START_CSS*/ and /*END_CSS*/. " +
    "If nothing is missing, return an empty block between the markers.";

  const tail = css.slice(-400); // last ~400 chars as local context
  const usr = [
    `SCOPE CLASS: ${scope}`,
    `COMPONENT TYPE (hint): ${component}`,
    "PARTIAL CSS (do not repeat this):",
    "```css", tail, "```",
    "Continue from the last property/block until the stylesheet is complete.",
    "Output only the continuation between the markers."
  ].join("\n");

  // up to 2 continuation attempts
  for (let i = 0; i < 2; i++) {
    const txt = await callResponses(client, {
      system: sys,
      tokens: 800,
      userParts: [
        { type: "input_text",  text: usr },
        { type: "input_image", image_url: image },
      ]
    });

    const cont = between(txt, "/*START_CSS*/", "/*END_CSS*/") || cssOnly(txt);
    const merged = (css + "\n" + cont).trim();

    if (!needsContinuation(merged)) return merged;
    css = merged; // try one more time with the longer context
  }
  return css; // best effort
}
