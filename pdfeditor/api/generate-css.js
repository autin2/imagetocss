// /api/generate-css.js
// Vision → CSS + HTML (neutral prompts, no prescriptive layout).
// 5-pass: draft → N-2 refinements (CSS only) → final (CSS+HTML).
// A minimal coherence guard keeps CSS/HTML consistent without imposing styles.

import OpenAI from "openai";

const MODEL = "gpt-4o-mini";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Read raw body (Vercel’s Node runtime)
    let body = "";
    for await (const chunk of req) body += chunk;
    const { image, palette = [], passes = 5 } = JSON.parse(body || "{}");

    if (!image || typeof image !== "string" || !image.startsWith("data:image")) {
      return res.status(400).json({ error: "Send { image: dataUrl, palette?: string[], passes?: number }" });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY not configured" });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // ---------- PASS 1: draft CSS ----------
    const draftCss = await firstPass(client, { image, palette });
    let currentCss = draftCss;

    // ---------- PASSES 2..N-1: refine CSS ----------
    const total = Math.max(1, Math.min(Number(passes) || 1, 8));
    for (let i = 2; i <= Math.max(1, total - 1); i++) {
      currentCss = await refineCssOnly(client, { image, palette, css: currentCss, passNum: i, total });
    }

    // ---------- FINAL PASS: return { css, html } ----------
    let final = await finalCssAndHtml(client, { image, palette, css: currentCss, passNum: total, total });

    // ---------- Coherence (neutral): ensure every HTML class exists in CSS ----------
    final = ensureHtmlCssCoherence(final);

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      draft: draftCss,
      css: final.css,
      html: final.html,
      passes: total
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to generate CSS/HTML." });
  }
}

/* ================= helpers ================= */

function sanitizeCss(text = "") {
  return String(text).replace(/^```(?:css)?\s*/i, "").replace(/```$/i, "").trim();
}

function parseJsonLoose(text) {
  try {
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    if (s >= 0 && e > s) return JSON.parse(text.slice(s, e + 1));
  } catch {}
  return null;
}

/**
 * Neutral coherence guard:
 * - Ensures every class used in HTML has a selector in CSS (appends empty rules if missing).
 * - Deduplicates class tokens in HTML.
 * - Does NOT inject opinionated styles or rename classes.
 */
function ensureHtmlCssCoherence({ css = "", html = "" }) {
  let outCss = sanitizeCss(css || "");
  let outHtml = String(html || "");

  // Collect classes used in HTML and dedupe class attributes
  const classAttrRegex = /class=(["'])(.*?)\1/gi;
  const usedClasses = new Set();

  outHtml = outHtml.replace(classAttrRegex, (_m, q, classes) => {
    const tokens = classes
      .split(/\s+/)
      .map(t => t.trim())
      .filter(Boolean);
    const deduped = Array.from(new Set(tokens));
    deduped.forEach(c => usedClasses.add(c));
    return `class=${q}${deduped.join(" ")}${q}`;
  });

  // For each used class, if CSS has no `.class` selector at all, append an empty rule.
  const missing = [];
  for (const cls of usedClasses) {
    const re = new RegExp(`\\.${escapeReg(cls)}\\b`);
    if (!re.test(outCss)) missing.push(cls);
  }
  if (missing.length) {
    outCss +=
      "\n\n/* Ensure all HTML classes exist (neutral, no-op rules) */\n" +
      missing.map(c => `.${c}{}`).join("\n");
  }

  return { css: outCss.trim(), html: outHtml.trim() };
}

function escapeReg(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ================= model calls ================= */

async function firstPass(client, { image, palette }) {
  const system =
    "You are a front-end CSS engine. Output VALID, vanilla CSS only (no HTML, no Markdown). " +
    "Your goal is to recreate the visual appearance of the provided image as a standalone stylesheet. " +
    "Avoid libraries and preprocessors.";

  const user =
    [
      "Study the screenshot and draft a CSS stylesheet that would reproduce what you see.",
      palette?.length
        ? `If a color palette is obvious, you MAY expose tokens under :root using these hexes when appropriate: ${palette.join(", ")}.`
        : "If a color palette is obvious, you MAY expose tokens under :root.",
      "Define only the classes you genuinely intend to use later; name things naturally.",
      "Be faithful to typography, color, spacing, and alignment you can observe. If a font is unknown, choose a reasonable system fallback.",
      "Do not output HTML or explanations—CSS only."
    ].join("\n");

  const r = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.15,
    max_tokens: 1400,
    messages: [
      { role: "system", content: system },
      { role: "user", content: [{ type: "text", text: user }, { type: "image_url", image_url: { url: image } }] }
    ]
  });

  return sanitizeCss(r?.choices?.[0]?.message?.content || "");
}

async function refineCssOnly(client, { image, palette, css, passNum, total }) {
  const system =
    "Return CSS only (no HTML, no Markdown). Correct, tighten, and refine to better match the screenshot. " +
    "Preserve existing class names when possible.";

  const user =
    [
      `Refinement pass ${passNum} of ${total}. Compare the screenshot with the CURRENT CSS and reduce visual error.`,
      "Adjust sizes, weights, spacing, colors, borders, and alignment as needed. Keep CSS valid and framework-free.",
      "No prose, no Markdown—CSS only.",
      "",
      "CURRENT CSS:",
      "```css",
      css,
      "```"
    ].join("\n");

  const r = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.12,
    max_tokens: 1500,
    messages: [
      { role: "system", content: system },
      { role: "user", content: [{ type: "text", text: user }, { type: "image_url", image_url: { url: image } }] }
    ]
  });

  return sanitizeCss(r?.choices?.[0]?.message?.content || css);
}

async function finalCssAndHtml(client, { image, palette, css, passNum, total }) {
  const system =
    'Return ONLY a JSON object with keys "css" and "html". No Markdown, no comments, no extra text. ' +
    "The CSS and HTML must be mutually consistent: every class used in HTML should be defined in CSS, and vice versa as needed.";

  const user =
    [
      `Final pass ${passNum} of ${total}. Produce the final CSS and a minimal HTML snippet that, together, reproduce the visible layout of the screenshot.`,
      "Do not invent unrelated content; use the visible text/labels you can read in the image.",
      "HTML should be concise and semantic. Use classes you defined in CSS; avoid inline styles unless strictly necessary (e.g., sizing an image).",
      palette?.length ? `If a palette is clear, you may use these hexes: ${palette.join(", ")}.` : "",
      "",
      "CURRENT CSS:",
      "```css",
      css,
      "```",
      "",
      'Return JSON like: {"css":"...","html":"..."} (no code fences).'
    ].join("\n");

  const r = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.12,
    max_tokens: 2000,
    messages: [
      { role: "system", content: system },
      { role: "user", content: [{ type: "text", text: user }, { type: "image_url", image_url: { url: image } }] }
    ]
  });

  const raw = r?.choices?.[0]?.message?.content || "";
  const json = parseJsonLoose(raw) || {};
  return {
    css: sanitizeCss(String(json.css || css)),
    html: String(json.html || "").trim()
  };
}
