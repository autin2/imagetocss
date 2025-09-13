// /api/generate-css.js
// Vercel Serverless Function — Image → scoped CSS + minimal HTML using GPT-5 only

const MODEL = "gpt-5";

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "method_not_allowed" });
    }

    const body = await readJson(req).catch(() => null);
    if (!body) return res.status(400).json({ error: "invalid_json_body" });

    const { image, scope = ".comp", component = "component", double_checks = 1 } = body;

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "missing_api_key" });
    }
    if (!image || typeof image !== "string" || !/^data:image\//.test(image)) {
      return res.status(400).json({ error: "bad_image" });
    }

    const system = [
      "You convert UI screenshots into compact, production-ready HTML + CSS.",
      "Rules:",
      "- Return STRICT JSON only: {\"css\":\"...\",\"html\":\"...\"}.",
      "- Scope ALL selectors under the provided scope class (e.g. .comp button {...}).",
      "- Approximate fonts/sizes/colors/borders/shadows from the image.",
      "- Include hover/focus-visible only if visually implied.",
      "- HTML must be the smallest usable snippet for just this component.",
      "- No external assets — use plain text/icons like →.",
    ].join("\n");

    const userText = [
      `Scope class: ${scope}`,
      `Component hint: ${component}`,
      "Infer styles from the image and output JSON ONLY with keys: css, html.",
    ].join("\n");

    // Call GPT-5
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
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
              { type: "image_url", image_url: { url: image } },
            ],
          },
        ],
      }),
    });

    const txt = await resp.text();
    if (!resp.ok) {
      return res.status(resp.status).json({ error: "openai_error", detail: txt });
    }

    let raw = txt.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
    let parsed = safeJson(raw);

    if (!parsed && Number(double_checks) > 0) {
      const fix = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0,
          messages: [
            { role: "system", content: "Return ONLY valid JSON. If input is not valid JSON, repair it. No comments." },
            { role: "user", content: raw },
          ],
        }),
      });
      const fixTxt = await fix.text();
      const fixRaw = fixTxt.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
      parsed = safeJson(fixRaw);
    }

    if (!parsed || typeof parsed.css !== "string" || typeof parsed.html !== "string") {
      return res.status(502).json({ error: "bad_model_output", raw });
    }

    return res.status(200).json({
      css: parsed.css.trim(),
      html: parsed.html.trim(),
      model: MODEL,
    });
  } catch (e) {
    return res.status(500).json({ error: "server_error", detail: String(e?.message || e) });
  }
};

// --- helpers ---
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}
