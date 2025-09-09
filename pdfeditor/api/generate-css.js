// api/generate-css.js
// Vision → CSS+HTML with 5-pass refine and robust HTML↔CSS coherence guard
import OpenAI from "openai";

const MODEL = "gpt-4o-mini";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Raw body (Vercel Node)
    let body = "";
    for await (const chunk of req) body += chunk;
    const { image, palette = [], passes = 5 } = JSON.parse(body || "{}");

    if (!image || typeof image !== "string" || !image.startsWith("data:image"))
      return res.status(400).json({ error: "Send { image: dataUrl, palette?: string[], passes?: number }" });
    if (!process.env.OPENAI_API_KEY)
      return res.status(500).json({ error: "OPENAI_API_KEY not configured" });

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // ----- pass 1: CSS draft -----
    const draftCss = await firstPass(client, { image, palette });
    let currentCss = draftCss;

    // ----- passes 2..N-1: refine CSS -----
    const total = Math.max(1, Math.min(Number(passes) || 1, 8));
    for (let i = 2; i <= total - 1; i++) {
      currentCss = await refineCssOnly(client, { image, palette, css: currentCss, passNum: i, total });
    }

    // ----- final pass: return { css, html } -----
    let final = await finalCssAndHtml(client, { image, palette, css: currentCss, passNum: total, total });

    // ----- GUARANTEE compatibility (no manual fixes needed) -----
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

/* ---------------- helpers ---------------- */

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

/** Make sure returned HTML & CSS actually work together. */
function ensureHtmlCssCoherence({ css = "", html = "" }) {
  let outCss = css || "";
  let outHtml = html || "";

  // 1) Ensure ANY btn-variant in HTML also has the base 'btn' class.
  outHtml = outHtml.replace(/class=(["'])(.*?)\1/g, (_m, q, classes) => {
    const toks = classes.trim().split(/\s+/).filter(Boolean);
    const hasBtn = toks.includes("btn");
    const hasVariant = toks.some(t => /^btn(?:--|-)/.test(t));
    if (hasVariant && !hasBtn) toks.unshift("btn");
    return `class=${q}${toks.join(" ")}${q}`;
  });

  // 2) If CSS lacks a shared base that cancels link defaults, append one.
  const needsBase =
    !/text-decoration\s*:\s*none/i.test(outCss) ||
    !/display\s*:\s*inline-flex/i.test(outCss) ||
    !/border-radius\s*:\s*999px/i.test(outCss) ||
    !/border\s*:\s*1px\s*solid/i.test(outCss) ||
    !/font-weight\s*:\s*7\d\d/i.test(outCss);

  const baseTargetsAnyVariant =
    /\.btn\s*,\s*\[class\*\="btn-"\]\s*\{[^}]*\}/is.test(outCss) ||
    /\[class\*\="btn-"\]\s*,\s*\.btn\s*\{[^}]*\}/is.test(outCss);

  if (needsBase || !baseTargetsAnyVariant) {
    outCss += `

/* Base styles for any "btn" element or variant ("btn-*") */
.btn, [class*="btn-"]{
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: 999px;
  font-weight: 700;
  cursor: pointer;
  transition: filter .3s;
}
a.btn:visited, a[class*="btn-"]:visited{ text-decoration:none; color:inherit; }
`;
  }

  // 3) If outline lacks a visible outline, add a minimal one.
  const outlineHasRule = /\.btn--outline\s*\{[^}]*\}/is.test(outCss);
  const outlineHasBorder = /(?:\.btn--outline\s*\{[^}]*)(border(?:-color)?\s*:|border\s*:)/is.test(outCss);
  if (!outlineHasRule || !outlineHasBorder) {
    outCss += `

/* Minimal outline variant */
.btn--outline{
  background: #fff;
  color: var(--ink, #111);
  border: 1px solid var(--border-light, #e5e7eb);
}
.btn:hover, [class*="btn-"]:hover{ filter: brightness(.92); }
`;
  }

  return { css: outCss.trim(), html: outHtml.trim() };
}

/* ---------------- model calls ---------------- */

async function firstPass(client, { image, palette }) {
  const system = [
    "You are a precise CSS generator.",
    "Return VANILLA CSS ONLY (no Sass/LESS, no Markdown fences, no HTML).",
    "Structure: :root tokens, utilities (.bg-*, .text-*, .border-*, .btn-*), and a .hero component."
  ].join(" ");

  const paletteLine = palette?.length
    ? `Use ONLY these hex colors when possible: ${palette.join(", ")}.`
    : "Infer a minimal palette (max 5 colors).";

  const user = [
    "Analyze the image and produce a complete stylesheet.",
    paletteLine,
    "Tokens must include --ink (text), --paper (background), and 3–5 brand colors.",
    "Buttons should be rounded (pill if appropriate).",
    "Output pure CSS only."
  ].join("\n");

  const r = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.15,
    max_tokens: 1200,
    messages: [
      { role: "system", content: system },
      { role: "user", content: [
        { type: "text", text: user },
        { type: "image_url", image_url: { url: image } }
      ] }
    ]
  });
  return sanitizeCss(r?.choices?.[0]?.message?.content || "");
}

async function refineCssOnly(client, { image, palette, css, passNum, total }) {
  const system = "Return CSS ONLY (no Markdown, no HTML).";
  const user = [
    `Refine pass ${passNum} of ${total}: compare the image and CURRENT CSS; fix deviations.`,
    "- Use the provided palette (or perceptual matches).",
    "- Hero heading: very large, extra-bold, uppercase; **negative** letter-spacing.",
    "- Button rules MUST cancel link defaults (text-decoration:none, inline-flex, radius 999px, border:1px solid transparent, font-weight:700).",
    "- If you introduce any variant named like 'btn-*' (e.g., btn--outline, btn-pill), ensure compatibility via a shared base selector (e.g., `.btn, [class*=\"btn-\"] { ... }`).",
    "- Hover stays in the same color family (e.g., filter:brightness(.92)).",
    "- Return CSS only.",
    "",
    "CURRENT CSS:\n```css\n" + css + "\n```",
    palette?.length ? "STRICT PALETTE: " + palette.join(", ") : "No explicit palette provided."
  ].join("\n");

  const r = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.1,
    max_tokens: 1400,
    messages: [
      { role: "system", content: system },
      { role: "user", content: [
        { type: "text", text: user },
        { type: "image_url", image_url: { url: image } }
      ] }
    ]
  });
  return sanitizeCss(r?.choices?.[0]?.message?.content || css);
}

async function finalCssAndHtml(client, { image, palette, css, passNum, total }) {
  const system = [
    'Return ONLY a JSON object with keys "css" and "html". No Markdown, no prose.',
    'The HTML must render correctly with the CSS you return — do not rely on any other styles.'
  ].join(" ");

  const user = [
    `Final pass ${passNum} of ${total}. Produce a cohesive CSS + HTML pair.`,
    "- Keep class names consistent between CSS and HTML.",
    "- Buttons:",
    "  * `.btn` (base) must include ALL resets (text-decoration:none, inline-flex, 1px solid transparent, radius:999px, font-weight:700, cursor:pointer, transition:filter .3s).",
    "  * Any variant named like `btn-*` (e.g., btn--outline, btn-pill) must be compatible with `.btn`. Prefer a shared base selector `.btn, [class*=\"btn-\"] { ... }`.",
    "  * In HTML, any variant must also include the base class, e.g. `<a class=\"btn btn--outline\">` or `<a class=\"btn btn-pill\">`.",
    "- Headline is large, extra-bold, uppercase; negative letter-spacing.",
    "- Use ONLY the given palette when possible: " + (palette?.length ? palette.join(", ") : "(no explicit palette)"),
    "",
    "CURRENT CSS:",
    "```css",
    css,
    "```",
    "",
    "Return JSON like: {\"css\":\"...\",\"html\":\"...\"}"
  ].join("\n");

  const r = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.1,
    max_tokens: 1700,
    messages: [
      { role: "system", content: system },
      { role: "user", content: [
        { type: "text", text: user },
        { type: "image_url", image_url: { url: image } }
      ] }
    ]
  });

  const raw = r?.choices?.[0]?.message?.content || "";
  const json = parseJsonLoose(raw) || {};
  return {
    css: sanitizeCss(String(json.css || css)),
    html: String(json.html || "").trim()
  };
}
