// Vercel serverless function — 2-pass CSS generation (draft + refine)
import OpenAI from "openai";

const MODEL = "gpt-4o-mini"; // fast, vision-capable

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Read raw body (Node on Vercel doesn't auto-parse)
    let body = "";
    for await (const chunk of req) body += chunk;
    const { image, palette = [], passes = 2 } = JSON.parse(body || "{}");

    if (!image || typeof image !== "string" || !image.startsWith("data:image")) {
      return res.status(400).json({ error: "Send { image: dataUrl, palette?: string[], passes?: 1|2 }" });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY not configured" });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // ---------- PASS 1: draft ----------
    const draft = await firstPass(client, { image, palette });

    let css = draft;
    // ---------- PASS 2: refine (optional) ----------
    if (passes > 1) {
      css = await refinePass(client, { image, palette, draft });
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ draft, css, palette });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to generate CSS." });
  }
}

// ----- HELPERS -----

function sanitizeCss(text = "") {
  return String(text)
    .replace(/^```(?:css)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

async function firstPass(client, { image, palette }) {
  const system = [
    "You are a precise CSS generator.",
    "Return VANILLA CSS ONLY (no Sass/LESS functions, no Markdown fences, no HTML).",
    "Structure: :root tokens, utilities (.bg-*, .text-*, .border-*, .btn-*), and 1–2 components (e.g., .header, .hero).",
    "Prefer high-contrast text; avoid vendor prefixes."
  ].join(" ");

  const paletteNote = palette?.length
    ? `Use ONLY these hex colors when possible: ${palette.join(", ")}.`
    : "Infer a minimal palette (max 5 colors).";

  const user = [
    "Analyze the image and produce a complete stylesheet.",
    paletteNote,
    "Tokens must include --ink (text), --paper (background), and 3–5 brand colors.",
    "Buttons should be rounded (pill if appropriate).",
    "Output pure CSS only."
  ].join("\n");

  const resp = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.15,
    max_tokens: 1200,
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

  return sanitizeCss(resp?.choices?.[0]?.message?.content || "");
}

async function refinePass(client, { image, palette, draft }) {
  const system = [
    "You are a CSS corrector and auditor.",
    "Return VANILLA CSS ONLY (no Markdown fences, no HTML).",
    "Preserve existing selector names from the provided CSS when possible.",
    "You may add missing declarations/selectors to better match the image.",
    "Ensure tokens and utilities are coherent and minimal."
  ].join(" ");

  const user = [
    "Task: Compare the reference image and the CURRENT CSS attempt.",
    "Fix deviations so the output is closer to a 1:1 match:",
    "- Use ONLY the given palette (or close perceptual matches).",
    "- Ensure :root tokens include --ink, --paper, brand colors; use #ffffff background if dominant.",
    "- Headline: very large, extra-bold, uppercase if present; tighten letter-spacing.",
    "- Buttons: rounded (ideally pill), hover darkens the same color (e.g. filter: brightness(0.92)).",
    "- Borders: light neutral (e.g. #e5e7eb) unless the image shows otherwise.",
    "- Remove Sass/LESS functions like darken(); only valid CSS.",
    "Return the corrected full CSS only.",
    "",
    "CURRENT CSS ATTEMPT:",
    "```css\n" + draft + "\n```",
    "",
    palette?.length ? "STRICT PALETTE: " + palette.join(", ") : "No explicit palette provided."
  ].join("\n");

  const resp = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.1,
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

  return sanitizeCss(resp?.choices?.[0]?.message?.content || draft);
}
