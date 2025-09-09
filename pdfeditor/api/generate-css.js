// /api/generate-css.js
// Vision → CSS only (no HTML). 5-pass pipeline: draft + 4 refinements.
// Response: { draft, css, versions, passes, palette }

import OpenAI from "openai";

const MODEL = "gpt-4o-mini"; // fast + vision-capable

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Read raw body (works on Vercel's Node runtime)
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

    // ----- PASS 1: draft CSS -----
    const draft = await firstPass(client, { image, palette });
    const versions = [draft];
    let current = draft;

    // ----- PASSES 2..N: refine CSS (double checks) -----
    const totalPasses = Math.max(1, Math.min(Number(passes) || 1, 8)); // cap for safety
    for (let i = 2; i <= totalPasses; i++) {
      current = await refinePass(client, { image, palette, css: current, passNum: i, totalPasses });
      versions.push(current);
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      draft,            // pass 1 CSS (raw draft)
      css: current,     // final refined CSS
      versions,         // CSS from every pass [1..N]
      passes: totalPasses,
      palette
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to generate CSS." });
  }
}

/* ---------------- helpers ---------------- */

function cssOnly(text = "") {
  // remove markdown fences if the model adds them
  return String(text).replace(/^```(?:css)?\s*/i, "").replace(/```$/i, "").trim();
}

/* ---------------- model calls ---------------- */

async function firstPass(client, { image, palette }) {
  const system =
    "You are a front-end CSS engine. Output VALID vanilla CSS only (no HTML, no Markdown, no comments). " +
    "Your stylesheet should recreate the visible appearance of the provided image. " +
    "Avoid preprocessors and libraries.";

  const user = [
    "Study the screenshot and draft a CSS stylesheet that reproduces what you see.",
    palette?.length
      ? `If a palette is clear, you MAY expose tokens under :root using these hexes where they visually match: ${palette.join(", ")}.`
      : "If a palette is clear, you MAY expose tokens under :root.",
    "Name classes naturally. Be faithful to typography, color, spacing, and alignment.",
    "Return CSS ONLY."
  ].join("\n");

  const r = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.15,
    max_tokens: 1400,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: user },
          { type: "image_url", image_url: { url: image } }
        ]
      }
    ]
  });

  return cssOnly(r?.choices?.[0]?.message?.content || "");
}

async function refinePass(client, { image, palette, css, passNum, totalPasses }) {
  const system =
    "Return CSS only (no HTML, no Markdown). Refine the stylesheet to better match the screenshot. " +
    "Preserve existing class names when possible.";

  const user = [
    `Refinement pass ${passNum} of ${totalPasses}. Compare the screenshot with the CURRENT CSS and reduce visual error.`,
    "Adjust sizes, weights, spacing, colors, borders, and alignment as needed. Keep CSS valid and framework-free.",
    "",
    "CURRENT CSS:",
    "```css",
    css,
    "```",
    palette?.length ? `Palette hint (optional): ${palette.join(", ")}` : ""
  ].join("\n");

  const r = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.12,
    max_tokens: 1500,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: user },
          { type: "image_url", image_url: { url: image } }
        ]
      }
    ]
  });

  return cssOnly(r?.choices?.[0]?.message?.content || css);
}
