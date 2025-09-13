// /api/generate-css.js
// ESM + Vercel Node runtime (default). GPT-5 ONLY. No fallbacks. No temperature (model requires default).

const MODEL = "gpt-5";

export default async function handler(req, res) {
  try {
    // --- Lightweight diagnostics ---
    if (req.method === "GET" && req.query?.diag === "1") {
      return res.status(200).json({
        ok: true,
        env_present: Boolean(process.env.OPENAI_API_KEY),
        node: process.version,
        model: MODEL,
      });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "method_not_allowed" });
    }

    // --- Read JSON body (works on Vercel Node serverless) ---
    let body = req.body;
    if (!body) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString("utf8");
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    }

    const { image, scope = ".comp", component = "component", double_checks = 1 } = body || {};

    // --- Validations ---
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "missing_api_key", hint: "Set OPENAI_API_KEY in Vercel → Project → Settings → Environment Variables." });
    }
    if (!image || typeof image !== "string" || !/^data:image\/(png|jpe?g|webp);base64,/.test(image)) {
      return res.status(400).json({ error: "bad_image", hint: "Send { image: dataURL } (png/jpg/webp). Use a cropped component screenshot." });
    }
    if (Buffer.byteLength(image, "utf8") > 4.2 * 1024 * 1024) {
      return res.status(413).json({ error: "image_too_large", hint: "Keep image dataURL under ~4MB. Crop or compress." });
    }

    // --- Prompt ---
    const system =
      "You convert UI component screenshots into compact, production-ready HTML + CSS.\n" +
      "Rules:\n" +
      '- Return STRICT JSON only: {"css":"...","html":"..."} (no prose, no code fences).\n' +
      "- Scope ALL selectors under the provided scope (e.g. .comp button {...}).\n" +
      "- Approximate fonts, sizes, colors, borders, radii, shadows from the image.\n" +
      "- Include :hover and :focus-visible only if visually implied.\n" +
      "- Minimal semantic HTML for just the component. No external assets; use plain text like →.";

    const userText =
      `Scope class: ${scope}\n` +
      `Component hint: ${component}\n` +
      "Infer styles from the image and output JSON ONLY with keys: css, html.";

    // --- OpenAI call (GPT-5 ONLY; no temperature field) ---
    const oai = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: [
              { type: "text", text: userText },
              { type: "image_url", image_url: { url: image } }, // correct multimodal shape
            ],
          },
        ],
      }),
    });

    const primaryJson = await oai.json().catch(() => null);
    if (!oai.ok || !primaryJson) {
      // Surface exact failure (401/403/404 if no GPT-5 access; 400 for bad params)
      return res.status(oai.status || 500).json({
        error: "openai_error",
        status: oai.status || 500,
        detail: primaryJson || (await oai.text().catch(() => "")),
      });
    }

    let content = primaryJson?.choices?.[0]?.message?.content ?? "";
    // Some models may wrap JSON in fences; strip cautiously
    content = String(content).trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();

    let parsed;
    try { parsed = JSON.parse(content); } catch { /* fall through to repair */ }

    // --- Optional repair pass (still GPT-5, no temperature) ---
    if (!parsed && Number(double_checks) > 0) {
      const fixResp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: "system", content: "Return ONLY valid JSON. If input is not valid JSON, repair it. No commentary." },
            { role: "user", content: content },
          ],
        }),
      });
      const fixJson = await fixResp.json().catch(() => null);
      let fix = fixJson?.choices?.[0]?.message?.content ?? "";
      fix = String(fix).trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
      try { parsed = JSON.parse(fix); } catch { /* ignore */ }
      if (!parsed) {
        return res.status(502).json({ error: "json_repair_failed", raw: (fix || content).slice(0, 500) });
      }
    }

    if (!parsed || typeof parsed.css !== "string" || typeof parsed.html !== "string") {
      return res.status(502).json({ error: "bad_model_output", raw: content.slice(0, 500) });
    }

    return res.status(200).json({
      css: parsed.css.trim(),
      html: parsed.html.trim(),
      model: MODEL,
    });
  } catch (e) {
    console.error("server_error", e);
    return res.status(500).json({ error: "server_error", detail: String(e?.message || e) });
  }
}
