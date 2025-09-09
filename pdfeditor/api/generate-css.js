// api/generate-css.js
// N-pass vision → CSS+HTML with built-in compatibility guard
import OpenAI from "openai";

const MODEL = "gpt-4o-mini"; // fast + vision-capable

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    // raw body (Vercel node runtime)
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

    // -------- PASS 1: CSS draft --------
    const draftCss = await firstPass(client, { image, palette });
    let currentCss = draftCss;

    // -------- PASSES 2..N: refine CSS --------
    const total = Math.max(1, Math.min(Number(passes) || 1, 8));
    for (let i = 2; i <= total - 1; i++) {
      currentCss = await refineCssOnly(client, { image, palette, css: currentCss, passNum: i, total });
    }

    // -------- FINAL PASS: return JSON { css, html } --------
    let final = await finalCssAndHtml(client, { image, palette, css: currentCss, passNum: total, total });

    // -------- Compatibility guard (HTML ↔ CSS) --------
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
  return String(text)
    .replace(/^```(?:css)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function parseJsonLoose(text) {
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
  } catch {}
  return null;
}

/** Ensures the returned HTML works with the returned CSS (no manual fixes needed). */
function ensureHtmlCssCoherence({ css = "", html = "" }) {
  let outCss = css || "";
  let outHtml = html || "";

  // 1) If HTML uses btn--outline without "btn", add it.
  outHtml = outHtml
    .replace(/class="([^"]*?)\bbtn--outline\b(?![^"]*\bbtn\b)([^"]*)"/g, 'class="$1btn btn--outline$2"')
    .replace(/class='([^']*?)\bbtn--outline\b(?![^']*\bbtn\b)([^']*)'/g, "class='$1btn btn--outline$2'");

  // 2) If CSS lacks shared base for .btn and .btn--outline, append a safe base.
  const hasBtnBase = /\.btn\s*\{[^}]*\}/s.test(outCss);
  const hasOutline = /\.btn--outline\s*\{[^}]*\}/s.test(outCss);
  const hasCombinedBase =
    /\.btn\s*,\s*\.btn--outline\s*\{[^}]*\}/s.test(outCss) ||
    /\.btn--outline\s*,\s*\.btn\s*\{[^}]*\}/s.test(outCss);

  const baseNeeded =
    // we need these base resets so links render as buttons
    !/text-decoration\s*:\s*none/.test(outCss) ||
    !/display\s*:\s*inline-flex/.test(outCss) ||
    !/border-radius\s*:\s*999px/.test(outCss) ||
    !/border\s*:\s*1px\s*solid/.test(outCss) ||
    !/font-weight\s*:\s*7\d\d/.test(outCss);

  if ((hasBtnBase || hasOutline) && (!hasCombinedBase || baseNeeded)) {
    outCss += `

/* Normalized button base so HTML always works with CSS */
.btn, .btn--outline{
  text-decoration:none;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  border:1px solid transparent;
  border-radius:999px;
  font-weight:700;
  cursor:pointer;
  transition:filter .3s;
}
a.btn:visited, a.btn--outline:visited{ text-decoration:none; color:inherit; }
`;
  }

  // 3) If outline has no visual style, give it a minimal border that matches your tokens.
  const outlineStyled =
    /\.btn--outline\s*\{[^}]*\}/s.test(outCss) &&
    (/border\s*:\s*1px\s*solid/.test(outCss) || /border-color\s*:/.test(outCss));

  if (!outlineStyled) {
    outCss += `

/* Minimal outline so the secondary button renders correctly */
.btn--outline{
  background:#fff;
  color:var(--ink);
  border:1px solid var(--border-light, #e5e7eb);
}
.btn:hover, .btn--outline:hover{ filter:brightness(.92); }
`;
  }

  return { css: outCss.trim(), html: outHtml.trim() };
}

/* ----------------- model calls ----------------- */

async function firstPass(client, { image, palette }) {
  const system = [
    "You are a precise CSS generator.",
    "Return VANILLA CSS ONLY (no Sass/LESS, no Markdown fences, no HTML).",
    "Structure: :root tokens, utilities (.bg-*, .text-*, .border-*, .btn-*), and a .hero component.",
  ].join(" ");

  const paletteNote = palette?.length
    ? `Use ONLY these hex colors when possible: ${palette.join(", ")}.`
    : "Infer a minimal palette (max 5 colors).";

  const user = [
    "Analyze the image and produce a complete stylesheet.",
    paletteNote,
    "Tokens must include --ink (text), --paper (background), and 3–5 brand colors.",
    "Buttons: rounded pill; high-contrast text; valid CSS only."
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
  const system = [
    "You are a CSS corrector. Return CSS ONLY (no Markdown, no HTML)."
  ].join(" ");

  const user = [
    `Refine pass ${passNum} of ${total}. Compare the image and CURRENT CSS; correct deviations.`,
    "- Use the provided palette (or perceptual matches).",
    "- Hero heading: very large, extra-bold, uppercase if present; **negative** letter-spacing.",
    "- Buttons: ensure class `.btn` resets link defaults (text-decoration:none, display:inline-flex, border-radius:999px, border:1px solid transparent, font-weight:700).",
    "- If an outline variant is present, your CSS MUST make it compatible with `.btn` by using a combined base selector `.btn, .btn--outline { ... }` (or equivalent), never leaving `.btn--outline` without the base.",
    "- Hover stays in the same color family (e.g., filter:brightness(.92)).",
    "- Return CSS only."
  ].join("\n") + `

CURRENT CSS:
\`\`\`css
${css}
\`\`\`
` + (palette?.length ? `STRICT PALETTE: ${palette.join(", ")}` : "No explicit palette provided.");

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
    "  * `.btn` contains ALL base button resets (text-decoration:none, display:inline-flex, border:1px solid transparent, border-radius:999px, font-weight:700, cursor:pointer).",
    "  * If you provide a secondary outline button, use the class name `.btn--outline` AND ensure compatibility via a combined base selector `.btn, .btn--outline { ... }` or by duplicating the base in `.btn--outline`.",
    "  * In the HTML, the secondary button MUST be `<a class=\"btn btn--outline\">` (include both classes).",
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
