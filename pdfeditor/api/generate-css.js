// api/generate-css.js
// N-pass CSS generation with final JSON payload { css, html }
import OpenAI from "openai";

const MODEL = "gpt-4o-mini"; // fast + vision-capable

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

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
    const first = await firstPass(client, { image, palette });
    const versions = [first];
    let currentCss = first;

    // ----- PASSES 2..N: refine -----
    const totalPasses = Math.max(1, Math.min(Number(passes) || 1, 8)); // safety cap
    let final = { css: currentCss, html: "" };

    for (let i = 2; i <= totalPasses; i++) {
      const out = await refinePass(client, {
        image,
        palette,
        css: currentCss,
        passNum: i,
        totalPasses,
        // Only the last pass must produce HTML; earlier passes can return CSS-only JSON.
        wantHtml: i === totalPasses
      });

      // Keep CSS for the next iteration; record each version's CSS
      currentCss = out.css || currentCss;
      versions.push(currentCss);
      if (i === totalPasses) final = out;
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      draft: versions[0],
      css: final.css,
      html: final.html,
      versions,              // array of CSS strings for all passes
      palette,
      passes: totalPasses
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to generate CSS." });
  }
}

/* ---------------- helpers ---------------- */

function sanitizeCss(text = "") {
  return String(text)
    .replace(/^```(?:css)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function safeParseJson(text) {
  try {
    // Grab the largest {...} block to survive stray prose
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
  } catch {}
  return null;
}

async function firstPass(client, { image, palette }) {
  const system = [
    "You are a precise CSS generator.",
    "Return VANILLA CSS ONLY (no Sass/LESS, no Markdown fences, no HTML).",
    "Structure: :root tokens, utilities (.bg-*, .text-*, .border-*, .btn-*), and 1–2 components (e.g., .hero).",
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
      { role: "user", content: [
          { type: "text", text: user },
          { type: "image_url", image_url: { url: image } }
        ] }
    ]
  });

  return sanitizeCss(resp?.choices?.[0]?.message?.content || "");
}

async function refinePass(client, { image, palette, css, passNum, totalPasses, wantHtml }) {
  const system = [
    "You are a CSS corrector and auditor.",
    wantHtml
      ? 'Return ONLY a JSON object with keys "css" and "html". No Markdown.'
      : 'Return ONLY a JSON object with key "css". No Markdown.'
  ].join(" ");

  const rules = [
    `Refinement pass ${passNum} of ${totalPasses}: compare the image and CURRENT CSS, then fix deviations.`,
    "- Use ONLY the given palette (or close perceptual matches).",
    "- If background is predominantly white, set --paper: #ffffff.",
    "- Headline: very large, extra-bold, uppercase if shown; tighten letter-spacing (negative tracking).",
    "- Buttons: class .btn must cancel link defaults: text-decoration:none; display:inline-flex; border:1px solid transparent; border-radius:999px; font-weight:700.",
    "- Provide a secondary outline style as .btn--outline that uses background:#fff; color:var(--ink); border:1px solid var(--border-light,#e5e7eb);",
    "- Hover must keep the same color family (e.g., filter:brightness(.92)), no gray swap.",
    "- Borders: light neutral (#e5e7eb) unless the image shows otherwise.",
    "- Keep structure (:root, utilities, components).",
    "",
    "CURRENT CSS:\n```css\n" + css + "\n```",
    palette?.length ? "STRICT PALETTE: " + palette.join(", ") : "No explicit palette provided."
  ].join("\n");

  if (wantHtml) {
    // Ask for html snippet that uses the CSS classes it outputs
    rules.concat("\nAlso include an HTML hero snippet using your classes: a large <h1>, a <p>, and two <a> buttons (.btn and .btn--outline).");
  }

  const resp = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.1,
    max_tokens: 1500,
    messages: [
      { role: "system", content: system },
      { role: "user", content: [
          { type: "text", text: rules },
          { type: "image_url", image_url: { url: image } }
        ] }
    ]
  });

  const raw = resp?.choices?.[0]?.message?.content || "";
  const json = safeParseJson(raw);

  if (json && typeof json === "object") {
    // Ensure strings
    return {
      css: typeof json.css === "string" ? sanitizeCss(json.css) : css,
      html: typeof json.html === "string" ? json.html.trim() : ""
    };
  }
  // Fallback: treat as CSS-only
  return { css: sanitizeCss(raw) || css, html: "" };
}
