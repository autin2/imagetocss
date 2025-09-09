// /api/generate-index.js
// Vision → a single self-contained HTML document (index.html)
// Neutral prompts (no prescriptive layout). 5-pass: CSS draft → refinements → final full HTML.
// Returns: text/html (save directly as index.html)

import OpenAI from "openai";

const MODEL = "gpt-4o-mini";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).send("Method not allowed");
    }

    // raw body (Vercel Node)
    let body = "";
    for await (const chunk of req) body += chunk;
    const { image, palette = [], passes = 5 } = JSON.parse(body || "{}");

    if (!image || typeof image !== "string" || !image.startsWith("data:image")) {
      return res.status(400).send("Send { image: dataUrl, palette?: string[], passes?: number }");
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).send("OPENAI_API_KEY not configured");
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // ----- PASS 1: draft CSS -----
    const draftCss = await passDraftCss(client, { image, palette });
    let css = draftCss;

    // ----- PASSES 2..N-1: refine CSS -----
    const total = Math.max(1, Math.min(Number(passes) || 1, 8));
    for (let i = 2; i <= Math.max(1, total - 1); i++) {
      css = await passRefineCss(client, { image, palette, css, passNum: i, total });
    }

    // ----- FINAL: return a complete HTML document (with <style> containing CSS) -----
    let htmlDoc = await passFinalIndexHtml(client, { image, palette, css, passNum: total, total });
    htmlDoc = ensureFullDocument(htmlDoc, css); // neutral guard: make sure it’s a full document

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(htmlDoc);
  } catch (err) {
    console.error(err);
    return res.status(500).send("Failed to generate index.html");
  }
}

/* ---------------- helpers ---------------- */

function stripFences(s = "") {
  return String(s)
    .replace(/^```(?:html)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function ensureFullDocument(content = "", fallbackCss = "") {
  let html = stripFences(content);

  const hasHtmlRoot = /<\s*html[\s>]/i.test(html);
  const hasHead = /<\s*head[\s>]/i.test(html);
  const hasBody = /<\s*body[\s>]/i.test(html);
  const hasStyle = /<\s*style[\s>]/i.test(html);

  // If the model returns just a fragment, wrap it.
  if (!hasHtmlRoot) {
    const safeCss = hasStyle ? "" : `<style>${fallbackCss}</style>`;
    html =
`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Generated UI</title>
  ${safeCss}
</head>
<body>
${html}
</body>
</html>`;
  } else if (!hasStyle && fallbackCss) {
    // If there is a <head> but no <style>, inject one with our refined CSS.
    if (hasHead) {
      html = html.replace(/<\s*head[\s>]/i, match => `${match}\n<style>${fallbackCss}</style>`);
    } else if (hasBody) {
      html = html.replace(/<\s*body[\s>]/i, match =>
        `</head>\n<body>\n<style>${fallbackCss}</style>\n`)
      // (Above branch should almost never happen, but keeps things robust.)
    }
  }

  return html;
}

/* ---------------- model passes ---------------- */

async function passDraftCss(client, { image, palette }) {
  const system =
    "You are a front-end CSS engine. Output VALID, vanilla CSS only. No HTML. No Markdown.";
  const user =
    [
      "Study the screenshot and draft a CSS stylesheet that reproduces what you see.",
      palette?.length
        ? `If appropriate, expose tokens under :root using these hex values when they visually match: ${palette.join(", ")}.`
        : "If appropriate, expose tokens under :root.",
      "Be faithful to typography, color, spacing, and alignment you can observe.",
      "No HTML, no explanations—CSS only."
    ].join("\n");

  const r = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.15,
    max_tokens: 1400,
    messages: [
      { role: "system", content: system },
      { role: "user", content: [
        { type: "text", text: user },
        { type: "image_url", image_url: { url: image } }
      ]}
    ]
  });
  return stripFences(r?.choices?.[0]?.message?.content || "");
}

async function passRefineCss(client, { image, palette, css, passNum, total }) {
  const system =
    "Return CSS only (no HTML, no Markdown). Correct and refine to better match the screenshot. Preserve class names when possible.";
  const user =
    [
      `Refinement pass ${passNum} of ${total}. Compare the screenshot with the CURRENT CSS and reduce visual error.`,
      "Adjust sizes, weights, spacing, colors, borders, and alignment as needed. Keep CSS valid and framework-free.",
      "Do not output HTML or prose—CSS only.",
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
      { role: "user", content: [
        { type: "text", text: user },
        { type: "image_url", image_url: { url: image } }
      ]}
    ]
  });
  return stripFences(r?.choices?.[0]?.message?.content || css);
}

async function passFinalIndexHtml(client, { image, palette, css, passNum, total }) {
  const system =
    'Return ONLY a complete, self-contained HTML document suitable to save as "index.html". ' +
    'It MUST include a <style> tag in <head> containing your final CSS and the <body> markup. ' +
    'No external assets, no Markdown fences, no explanations. Valid HTML only.';

  const user =
    [
      `Final pass ${passNum} of ${total}. Produce the final, self-contained index.html.`,
      "Use the CURRENT CSS below (you may modify it further if needed).",
      "Keep class names consistent between the CSS you embed and the HTML you output.",
      "Use only visible text you can read from the screenshot; keep the structure minimal and faithful.",
      palette?.length ? `Palette hint (optional): ${palette.join(", ")}` : "",
      "",
      "CURRENT CSS:",
      "```css",
      css,
      "```"
    ].join("\n");

  const r = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.12,
    max_tokens: 2400,
    messages: [
      { role: "system", content: system },
      { role: "user", content: [
        { type: "text", text: user },
        { type: "image_url", image_url: { url: image } }
      ]}
    ]
  });

  return stripFences(r?.choices?.[0]?.message?.content || "");
}
