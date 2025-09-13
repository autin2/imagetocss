// /api/generate-css.js
// Vercel Serverless Function — turns a component screenshot into scoped CSS + HTML
//
// ENV required on Vercel:
//   OPENAI_API_KEY=<your key>
// Optional:
//   OPENAI_MODEL=gpt-4o-mini  (default below)

const MODEL = process.env.OPENAI_MODEL || "gpt-5";

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    const { image, scope = ".comp", component = "component", double_checks = 0 } =
      (await readJson(req)) || {};

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }
    if (!image || typeof image !== "string" || !image.startsWith("data:image")) {
      return res.status(400).json({ error: "Send { image:dataURL }" });
    }

    // --- Prompt --------------------------------------------------------------
    const system = [
      "You convert UI screenshots into compact, production-ready HTML + CSS.",
      "Rules:",
      "- Output STRICT JSON only: {\"css\":\"...\",\"html\":\"...\"} (no backticks).",
      "- Scope ALL selectors under the provided scope class (e.g. .comp button {...}).",
      "- Use semantic CSS with approximated values (padding, radius, border, shadows).",
      "- Prefer neutral CSS (no frameworks).",
      "- Include :hover and :focus-visible only when visually implied.",
      "- Keep CSS readable but tight; avoid resets or wildcards.",
      "- HTML should be the smallest usable snippet for the component.",
      "- Do NOT invent external assets; use plain text/icons (e.g., →).",
    ].join("\n");

    const userText = [
      `Scope class: ${scope}`,
      `Component hint: ${component}`,
      "Infer fonts, sizes, colors, borders, and effects from the image.",
      "Return JSON ONLY (no prose, no fences). Keys: css, html.",
    ].join("\n");

    // --- Call OpenAI (multimodal) -------------------------------------------
    const openaiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: [
              { type: "text", text: userText },
              { type: "image_url", image_url: image },
            ],
          },
        ],
      }),
    });

    if (!openaiResp.ok) {
      const errText = await safeText(openaiResp);
      return res.status(openaiResp.status).json({ error: "openai_error", detail: errText });
    }

    const data = await openaiResp.json();
    let raw = data?.choices?.[0]?.message?.content || "";

    // Some models may wrap in fences—strip them just in case.
    raw = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();

    // First parse
    let parsed = safeJson(raw);

    // Optional second pass (ask model to fix to valid JSON if needed)
    if (!parsed && Number(double_checks) > 0) {
      const fixer = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0,
          messages: [
            {
              role: "system",
              content:
                "Return ONLY valid JSON. If input is not valid JSON, repair it. Do not add explanations.",
            },
            { role: "user", content: raw },
          ],
        }),
      });
      const fixData = await fixer.json().catch(() => ({}));
      const fixRaw = fixData?.choices?.[0]?.message?.content || "";
      parsed = safeJson(fixRaw);
    }

    if (!parsed || typeof parsed.css !== "string" || typeof parsed.html !== "string") {
      return res.status(502).json({
        error: "bad_model_output",
        raw,
      });
    }

    // Ensure scoping exists (light safety net)
    if (!parsed.css.includes(scope)) {
      parsed.css = parsed.css
        .split("\n")
        .map((line) => line)
        .join("\n");
      // (We rely on the prompt to scope correctly; additional rewriting could break styles.)
    }

    return res.status(200).json({
      css: parsed.css.trim(),
      html: parsed.html.trim(),
      model: MODEL,
    });
  } catch (err) {
    return res.status(500).json({ error: "server_error", detail: String(err?.message || err) });
  }
};

// ----------------- helpers -----------------
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function safeJson(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

async function safeText(resp) {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}
