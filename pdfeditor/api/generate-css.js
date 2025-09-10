// /api/generate-css.js
// Timeout-safe, component-scoped CSS generator (Responses API).
// Returns a complete, scoped CSS block. Avoids serverless 504s with a deadline.

import OpenAI from "openai";

// === Tunables / sensible defaults ===
// Use GPT-5 (override via env). You can also try "gpt-5-mini" for speed.
const MODEL = process.env.OPENAI_MODEL || "gpt-5";

// Max critique→fix loops (hard cap). Default: 2 (fast) — override in env.
const MAX_CYCLES = Number(process.env.MAX_CYCLES || 2);

// Total time budget for this function in ms (keep under platform timeout).
// Hobby serverless is ~10s, so we use 9000ms by default.
const FN_DEADLINE_MS = Number(process.env.FN_DEADLINE_MS || 9000);

// Token budgets (smaller → faster)
const TOKENS = {
  draft: 900,
  critique: 400,
  fix: 1000,
  cont: 350,
};

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
      // caller can ask for more loops, we still clamp to MAX_CYCLES
      double_checks = 2,
      scope = ".comp",
      component = "component",
    } = data || {};

    if (!image || typeof image !== "string" || !image.startsWith("data:image")) {
      return res.status(400).json({
        error:
          "Bad request: send JSON { image: <data:image/...;base64,>, palette?, double_checks?, scope?, component? } with Content-Type: application/json",
      });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY not configured" });
    }

    // Size guard
    const approxBytes = Buffer.byteLength(image, "utf8");
    if (approxBytes > 4.5 * 1024 * 1024) {
      return res.status(413).json({ error: "Image too large. Keep under ~4MB." });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const deadline = Date.now() + FN_DEADLINE_MS;

    // ----- DRAFT -----
    let draft = await passDraft(client, { image, palette, scope, component, deadline });
    draft = enforceScope(draft, scope);
    draft = await ensureComplete(client, { css: draft, image, scope, component, deadline });

    const versions = [draft];
    let css = draft;
    let lastCritique = "";

    // ----- CRITIQUE → FIX LOOPS (clamped + deadline-aware) -----
    const cycles = Math.max(1, Math.min(Number(double_checks) || 1, MAX_CYCLES));
    for (let i = 1; i <= cycles; i++) {
      if (timeLeft(deadline) < 1500) break; // not enough time left safely

      lastCritique = await passCritique(client, {
        image, css, palette, scope, component, cycle: i, total: cycles, deadline
      });

      if (timeLeft(deadline) < 1500) break;

      let fixed = await passFix(client, {
        image, css, critique: lastCritique, palette, scope, component, cycle: i, total: cycles, deadline
      });

      fixed = enforceScope(fixed, scope);
      fixed = await ensureComplete(client, { css: fixed, image, scope, component, deadline });
      css = fixed;
      versions.push(css);
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      draft,
      css,
      versions,
      passes: 1 + versions.length * 0 + cycles * 2, // cosmetic; draft + (critique/fix)*cycles
      palette,
      notes: lastCritique,
      scope,
      component,
    });
  } catch (err) {
    const status =
      err?.status ||
      err?.statusCode ||
      err?.response?.status ||
      (String(err?.message || "").includes("JSON body") ? 400 : 500);

    const toStr = (x) => {
      if (typeof x === "string") return x;
      try { return JSON.stringify(x, Object.getOwnPropertyNames(x), 2); }
      catch { return String(x); }
    };

    console.error("[/api/generate-css] Error:", toStr(err));
    const details = err?.response?.data ?? err?.data ?? undefined;

    return res.status(status).json({
      error: toStr(err?.message) || toStr(details) || "Failed to generate CSS.",
      details,
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

function timeLeft(deadline) {
  return Math.max(0, deadline - Date.now());
}

function abortSignalFor(deadline, minMs = 600) {
  const ms = Math.max(minMs, timeLeft(deadline));
  // Node 18+ supports AbortSignal.timeout; fallback to manual controller
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), ms);
  return ctl.signal;
}

function between(text, a, b) {
  const i = text.indexOf(a); if (i === -1) return null;
  const j = text.indexOf(b, i + a.length); if (j === -1) return null;
  return text.slice(i + a.length, j);
}

function cssOnly(s = "") {
  return String(s).replace(/^```(?:css)?\s*/i, "").replace(/```$/i, "").trim();
}

/** Prefix all non-@ rules (except :root) with the scope class. */
function enforceScope(inputCss = "", scope = ".comp") {
  let css = String(inputCss || "").trim();
  css = css.replace(/(^|})\s*([^@}{]+?)\s*\{/g, (m, p1, selectors) => {
    const scoped = selectors
      .split(",").map(s => s.trim())
      .map(sel => sel.startsWith(scope) || sel.startsWith(":root") || !sel ? sel : `${scope} ${sel}`)
      .join(", ");
    return `${p1} ${scoped} {`;
  });
  return css.trim();
}

// Detect truncated CSS heuristically
function needsContinuation(css) {
  const t = (css || "").trim();
  if (!t) return true;
  if (!/\}\s*$/.test(t)) return true;
  const opens = (t.match(/{/g) || []).length;
  const closes = (t.match(/}/g) || []).length;
  if (closes < opens) return true;
  if (/[,:]\s*$/.test(t)) return true;
  return false;
}

/* ===== Responses API glue ===== */

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

async function callResponses(client, { system, userParts, tokens, deadline }) {
  // If almost out of time, return empty so caller can bail gracefully
  if (timeLeft(deadline) < 600) return "";
  const signal = abortSignalFor(deadline, 700);

  const r = await client.responses.create(
    {
      model: MODEL,
      max_output_tokens: tokens,
      input: [
        { role: "system", content: [{ type: "input_text", text: system }] },
        { role: "user",   content: userParts },
      ],
    },
    { signal }
  );

  return extractText(r) || "";
}

/* ================= passes ================= */

async function passDraft(client, { image, palette, scope, component, deadline }) {
  const sys =
    "You are a CSS engine. Return VALID vanilla CSS ONLY (no HTML/Markdown). " +
    "Input is a PHOTO/CROPPED SCREENSHOT of ONE UI COMPONENT (not a full page). " +
    "Rules: (1) All selectors scoped under the provided SCOPE CLASS; " +
    "(2) No global resets/layout; (3) Keep styles minimal and faithful. " +
    "Wrap the CSS between /*START_CSS*/ and /*END_CSS*/ exactly.";

  const usr = [
    `SCOPE CLASS: ${scope}`,
    `COMPONENT TYPE (hint): ${component}`,
    palette?.length ? `Optional palette tokens: ${palette.join(", ")}` : "No palette tokens.",
    "Produce CSS for that SINGLE component ONLY.",
    "Return CSS ONLY, wrapped in the markers."
  ].join("\n");

  const txt = await callResponses(client, {
    system: sys,
    userParts: [
      { type: "input_text",  text: usr },
      { type: "input_image", image_url: image },
    ],
    tokens: TOKENS.draft,
    deadline
  });

  const betweenCss = between(txt, "/*START_CSS*/", "/*END_CSS*/");
  return betweenCss ? betweenCss.trim() : cssOnly(txt);
}

async function passCritique(client, { image, css, palette, scope, component, cycle, total, deadline }) {
  const sys =
    "You are a strict component QA assistant. Do NOT output CSS. " +
    "Compare the PHOTO of the SINGLE COMPONENT with the CURRENT CSS. " +
    "List precise mismatches (spacing, radius, borders, colors, size, typography, states). Be terse.";

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
    userParts: [
      { type: "input_text",  text: usr },
      { type: "input_image", image_url: image },
    ],
    tokens: TOKENS.critique,
    deadline
  });

  return String(txt).replace(/```[\s\S]*?```/g, "").trim();
}

async function passFix(client, { image, css, critique, palette, scope, component, deadline }) {
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
    userParts: [
      { type: "input_text",  text: usr },
      { type: "input_image", image_url: image },
    ],
    tokens: TOKENS.fix,
    deadline
  });

  const betweenCss = between(txt, "/*START_CSS*/", "/*END_CSS*/");
  return betweenCss ? betweenCss.trim() : cssOnly(txt);
}

async function ensureComplete(client, { css, image, scope, component, deadline }) {
  if (!needsContinuation(css)) return css;

  const sys =
    "Continue the CSS EXACTLY where it stopped. Do NOT repeat earlier lines. " +
    "Return CSS continuation ONLY, between /*START_CSS*/ and /*END_CSS*/. " +
    "If nothing is missing, return an empty block between the markers.";

  const tail = (css || "").slice(-400);
  const usr = [
    `SCOPE CLASS: ${scope}`,
    `COMPONENT TYPE (hint): ${component}`,
    "PARTIAL CSS (do not repeat this):",
    "```css", tail, "```",
    "Continue from the last property/block until the stylesheet is complete.",
    "Output only the continuation between the markers."
  ].join("\n");

  // Single attempt for speed
  const txt = await callResponses(client, {
    system: sys,
    userParts: [
      { type: "input_text",  text: usr },
      { type: "input_image", image_url: image },
    ],
    tokens: TOKENS.cont,
    deadline
  });

  const cont = between(txt, "/*START_CSS*/", "/*END_CSS*/") || cssOnly(txt);
  const merged = (css + (cont ? "\n" + cont : "")).trim();
  return needsContinuation(merged) ? css : merged;
}
