// /api/generate-css.js
// CSS-only, component-scoped generator with N Critique→Fix cycles.
// Response: { draft, css, versions, passes, palette, notes, scope, component }

import OpenAI from "openai";

// === Model config ===
// Use GPT-5 by default; allow override via env for quick A/B tests (e.g. gpt-5-mini)
const MODEL = process.env.OPENAI_MODEL || "gpt-5";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    // raw body (Vercel)
    let body = "";
    for await (const chunk of req) body += chunk;
    const {
      image,
      palette = [],
      double_checks = 6,       // default 6 critique/fix cycles
      scope = ".comp",         // root scope class
      component = "component"  // hint: "button", "card", "input", etc.
    } = JSON.parse(body || "{}");

    if (!image || typeof image !== "string" || !image.startsWith("data:image")) {
      return res.status(400).json({ error: "Send { image: dataUrl, palette?, double_checks?, scope?, component? }" });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY not configured" });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // ---------- DRAFT ----------
    let draft = await passDraft(client, { image, palette, scope, component });
    draft = enforceScope(draft, scope);
    const versions = [draft];
    let css = draft;
    let lastCritique = "";

    // ---------- DOUBLE-CHECKS (Critique → Fix) ----------
    const cycles = Math.max(1, Math.min(Number(double_checks) || 1, 8));
    for (let i = 1; i <= cycles; i++) {
      lastCritique = await passCritique(client, { image, css, palette, scope, component, cycle: i, total: cycles });
      let fixed = await passFix(client, { image, css, critique: lastCritique, palette, scope, component, cycle: i, total: cycles });
      fixed = enforceScope(fixed, scope);
      css = fixed;
      versions.push(css);
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      draft,
      css,
      versions,
      passes: 1 + cycles * 2, // 1 draft + (critique+fix)*cycles
      palette,
      notes: lastCritique,
      scope,
      component
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to generate CSS." });
  }
}

/* ================= helpers ================= */

function cssOnly(text = "") {
  return String(text).replace(/^```(?:css)?\s*/i, "").replace(/```$/i, "").trim();
}
function textOnly(s = "") {
  return String(s).replace(/```[\s\S]*?```/g, "").trim();
}

/**
 * Enforce scope: prefix all non-@ rules (except :root) with the scope class.
 * Pragmatic regex guard that covers common outputs.
 */
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

/* ================= model passes ================= */

async function passDraft(client, { image, palette, scope, component }) {
  // Emphasize: photo/cropped screenshot of ONE component — never full page
  const sys =
    "You are a front-end CSS engine. Output VALID vanilla CSS only (no HTML/Markdown). " +
    "Input is a PHOTO or CROPPED SCREENSHOT of ONE UI COMPONENT (not a full page). " +
    "Your job: reproduce only that component’s styles. " +
    "Hard rules: (1) All selectors MUST be under the provided SCOPE CLASS; " +
    "(2) No global resets, no layout, no headers/footers, no containers or pages; " +
    "(3) Keep styles minimal, faithful to the photo, and practical.";

  const usr = [
      `SCOPE CLASS: ${scope}`,
      `COMPONENT TYPE (hint): ${component}`,
      "Task: Study the SINGLE component in the photo and output CSS for that component ONLY.",
      "Do NOT invent page structures or unrelated styles. No body/html/universal selectors.",
      "If states (hover/focus/disabled) are clearly implied, include them; otherwise omit.",
      palette?.length
        ? `Optional palette tokens (use only if they match the look): ${palette.join(", ")}`
        : "No palette tokens required.",
      "Return CSS ONLY."
    ].join("\n");

  const r = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.15,
    max_tokens: 1400,
    // You can add: reasoning: { effort: "minimal" } if your SDK supports it on Chat Completions.
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

async function passCritique(client, { image, css, palette, scope, component, cycle, total }) {
  const sys =
    "You are a strict component QA assistant. Do NOT output CSS. " +
    "Compare the PHOTO/CROPPED SCREENSHOT of a SINGLE COMPONENT with the CURRENT CSS. " +
    "Identify concrete mismatches (alignment, spacing, radius, borders, colors, size, typography, hover/focus/disabled). " +
    "Ensure selectors remain under the provided scope. Be terse.";

  const usr = [
      `Critique ${cycle}/${total} (component-level only).`,
      `SCOPE CLASS: ${scope}`,
      `COMPONENT TYPE (hint): ${component}`,
      "List actionable corrections with target selectors when possible.",
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

async function passFix(client, { image, css, critique, palette, scope, component, cycle, total }) {
  const sys =
    "Return CSS only (no HTML/Markdown). " +
    "Overwrite the stylesheet to resolve the critique and better match the PHOTO/CROPPED SCREENSHOT of the SINGLE COMPONENT. " +
    "All selectors must remain under the provided scope. No global resets, no page-level structures.";

  const usr = [
      `Fix ${cycle}/${total} for the component.`,
      `SCOPE CLASS: ${scope}`,
      `COMPONENT TYPE (hint): ${component}`,
      "Rules:",
      "- Keep all selectors under the scope.",
      "- No body/html/universal selectors. No page-level structures.",
      "- Adjust alignment, spacing, borders, radius, colors, typography, and states to match the photo.",
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
