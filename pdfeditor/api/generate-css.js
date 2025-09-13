const MODEL = "gpt-5";

export default async function handler(req, res) {
  try {
    // Quick diagnostics
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

    // Read JSON body (works on Vercel Node)
    let body = req.body;
    if (!body) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString("utf8");
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    }

    const { image, scope = ".comp", component = "component", double_checks = 1 } = body || {};

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "missing_api_key" });
    }
    if (!image || typeof image !== "string" || !/^data:image\/(png|jpe?g|webp);base64,/.test(image)) {
      return res.status(400).json({ error: "bad_image", hint: "Send { image: dataURL } (png/jpg/webp)." });
    }
    if (Buffer.byteLength(image, "utf8") > 4.2 * 1024 * 1024) {
      return res.status(413).json({ error: "image_too_large" });
    }

    const system =
      "You convert UI screenshots into compact, production-ready HTML + CSS.\n" +
      "Rules:\n" +
      "- Return STRICT JSON only: {\"css\":\"...\",\"html\":\"...\"}.\n" +
      "- Scope ALL selectors under the provided scope (e.g. .comp button {...}).\n" +
      "- Approximate fonts/sizes/colors/borders/shadows from the image.\n" +
      "- Include :hover and :focus-visible when visually implied.\n" +
      "- Minimal semantic HTML; no external assets.";

    const userText =
      `Scope class: ${scope}\n` +
      `Component hint: ${component}\n` +
      "Infer styles from the image and output JSON ONLY with keys: css, html.";

    // ---- OpenAI (GPT-5 ONLY) ----
    const oai = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
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

    const rawText = await oai.text();

    if (!oai.ok) {
      // You’ll see 401/403/404 here if you don’t have GPT-5 API access
      return res.status(oai.status).json({
        error: "openai_error",
        status: oai.status,
        detail: rawText,
      });
    }

    // Strip code fences if present
    let content = rawText.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();

    let parsed;
    try { parsed = JSON.parse(content); } catch { /* continue */ }

    // Optional JSON repair
    if (!parsed && Number(double_checks) > 0) {
      const fix = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0,
          messages: [
            { role: "system", content: "Return ONLY valid JSON. If input is not valid JSON, repair it. No commentary." },
            { role: "user", content: content },
          ],
        }),
      });
      const fixTxt = await fix.text();
      const fixRaw = fixTxt.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
      try { parsed = JSON.parse(fixRaw); } catch { /* ignore */ }
    }

    if (!parsed || typeof parsed.css !== "string" || typeof parsed.html !== "string") {
      return res.status(502).json({ error: "bad_model_output", raw: content.slice(0, 400) });
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
