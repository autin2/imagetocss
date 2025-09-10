// /api/generate-css.js
// Vision → CSS only. Draft + 5 "double-check" cycles (Critique → Fix).
// Response: { draft, css, versions, passes, palette, notes }

import OpenAI from "openai";

const MODEL = "gpt-4o-mini"; // vision-capable + fast

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Read raw body (Vercel Node runtime)
    let body = "";
    for await (const chunk of req) body += chunk;
    const { image, palette = [], double_checks = 5 } = JSON.parse(body || "{}");

    if (!image || typeof image !== "string" || !image.startsWith("data:image")) {
      return res.status(400).json({ error: "Send { image: dataUrl, palette?: string[], double_checks?: number }" });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY not configured" });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // ---------- PASS 1: DRAFT ----------
    const draft = await passDraft(client, { image, palette });
    let css = draft;
    const versions = [draft];

    // ---------- 5 DOUBLE-CHECKS (Critique → Fix) ----------
    const cycles = Math.max(1, Math.min(Number(double_checks) || 1, 8));
    let lastCritique = "";

    for (let i = 1; i <= cycles; i++) {
      // A) CRITIQUE (no CSS output, just a short, structured critique text we feed into fixer)
      lastCritique = await passCritique(client, { image, css, palette, cycle: i, total: cycles });

      // B) FIX (return full, corrected CSS only)
      css = await passFix(client, { image, css, critique: lastCritique, palette, cycle: i, total: cycles });
      versions.push(css);
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      draft,            // initial CSS
      css,              // final CSS after 5 double-checks
      versions,         // [draft, after cycle1, after cycle2, ...]
      passes: 1 + cycles * 2, // 1 draft + (critique+fix)*cycles
      palette,
      notes: lastCritique // last critique text (useful for debugging)
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to generate CSS." });
  }
}

/* ================= helpers ================= */

function cssOnly(text = "") {
  // remove any accidental fences / prose
  return String(text).replace(/^```(?:css)?\s*/i, "").replace(/```$/i, "").trim();
}

function textOnly(s = "") {
  return String(s).replace(/```[\s\S]*?```/g, "").trim();
}

/* ================= model passes ================= */

async function passDraft(client, { image, palette }) {
  const sys =
    "You are a front-end CSS engine. Output VALID vanilla CSS only (no HTML, no Markdown). " +
    "Your stylesheet must recreate the visible appearance of the provided image as closely as possible. " +
    "Avoid frameworks and preprocessors.";

  const usr =
    [
      "Study the screenshot and produce a first draft stylesheet.",
      palette?.length
        ? `If a palette is evident, you MAY expose :root tokens using these hexes when they visually match: ${palette.join(", ")}.`
        : "If a palette is evident, you MAY expose :root tokens.",
      "Preserve browser defaults only where they clearly match the image; otherwise neutralize them (e.g., bullets, underlines, default margins).",
      "Name classes naturally. Return CSS ONLY."
    ].join("\n");

  const r = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.15,
    max_tokens: 1400,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: [
          { type: "text", text: usr },
          { type: "image_url", image_url: { url: image } }
        ] }
    ]
  });

  return cssOnly(r?.choices?.[0]?.message?.content || "");
}

async function passCritique(client, { image, css, palette, cycle, total }) {
  const sys =
    "You are a strict visual QA assistant. Do NOT output CSS. " +
    "Compare the screenshot to the CURRENT CSS and identify concrete mismatches. " +
    "Be terse and specific. No HTML.";

  const usr =
    [
      `Critique ${cycle}/${total}. Compare CURRENT CSS to the screenshot and list the top issues to fix.`,
      "- Consider: alignment (left/center), spacing (margins/padding), list bullets and default margins, link underlines/visited color, fonts/weights/sizes/line-height, colors (primary/neutral), borders/dividers, corner radii (pills vs rounded), button width and shape, section backgrounds/bands.",
      "- Output a short checklist with specific corrections and target selectors when possible.",
      "",
      "CURRENT CSS:",
      "```css",
      css,
      "```",
      palette?.length ? `Palette hint: ${palette.join(", ")}` : ""
    ].join("\n");

  const r = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.05,
    max_tokens: 900,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: [
          { type: "text", text: usr },
          { type: "image_url", image_url: { url: image } }
        ] }
    ]
  });

  return textOnly(r?.choices?.[0]?.message?.content || "");
}

async function passFix(client, { image, css, critique, palette, cycle, total }) {
  const sys =
    "Return CSS only (no HTML, no Markdown). Overwrite the stylesheet to resolve the critique " +
    "and better match the screenshot. Keep or refine class names; do not output diffs—return the FULL updated stylesheet.";

  const usr =
    [
      `Fix ${cycle}/${total}. Update the CSS to address the critique below and match the screenshot more closely.`,
      "Rules:",
      "- Be faithful to observed alignment; do not center content unless the screenshot clearly centers it.",
      "- Remove unwanted bullets/underlines/default margins when they don't match the screenshot.",
      "- Ensure buttons look like the screenshot (pill radius vs rounded, width, weight, colors).",
      "- Scope styles carefully; avoid over-broad container rules that misalign child elements.",
      "- Keep CSS valid and framework-free. Return CSS ONLY.",
      "",
      "CRITIQUE:",
      critique || "(none)",
      "",
      "CURRENT CSS:",
      "```css",
      css,
      "```",
      palette?.length ? `Palette hint (optional): ${palette.join(", ")}` : ""
    ].join("\n");

  const r = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.1,
    max_tokens: 1600,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: [
          { type: "text", text: usr },
          { type: "image_url", image_url: { url: image } }
        ] }
    ]
  });

  return cssOnly(r?.choices?.[0]?.message?.content || css);
}
