// Vercel Serverless Function (Node) — Image → CSS/HTML using GPT-5 ONLY
// Shows precise error messages instead of a blank 500.

const MODEL = "gpt-5";

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "method_not_allowed" });
    }

    // --- read JSON body (Node IncomingMessage) ---
    const body = await readJson(req).catch((e) => {
      console.error("invalid_json_body", e);
      return null;
    });
    if (!body) return res.status(400).json({ error: "invalid_json_body" });

    const { image, scope = ".comp", component = "component", double_checks = 1 } = body;

    // --- quick validations ---
    if (!process.env.OPENAI_API_KEY) {
      console.error("missing OPENAI_API_KEY");
      return res.status(500).json({ error: "missing_api_key" });
    }
    if (!image || typeof image !== "string" || !/^data:image\/(png|jpe?g|webp);base64,/.test(image)) {
      return res.status(400).json({
        error: "bad_image",
        hint: "Send { image: dataURL } (png/jpg/webp).",
      });
    }
    const approxBytes = Buffer.byteLength(image, "utf8");
    if (approxBytes > 4.2 * 1024 * 1024) {
      return res.status(413).json({
        error: "image_too_large",
        hint: "Keep image dataURL under ~4MB. Crop or compress.",
      });
    }

    const system = [
      "You convert UI screenshots into compact, production-ready HTML + CSS.",
      "Rules:",
      "- Return STRICT JSON only: {\"css\":\"...\",\"html\":\"...\"}.",
      "- Scope ALL selectors under the provided scope (e.g. .comp button {...}).",
      "- Approximate fonts/sizes/colors/borders/shadows from the image.",
      "- Include :hover and :focus-visible when visually implied.",
      "- Minimal semantic HTML; no external assets.",
    ].join("\n");

    const userText = [
      `Scope class: ${scope}`,
      `Component hint: ${component}`,
      "Infer styles from the image and output JSON ONLY with keys: css, html.",
    ].join("\n");

    // --- OpenAI call (GPT-5 ONLY) ---
    const oai = await fetch("https://api.openai.com/v1/chat/completions", {
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
              { type: "image_url", image_url: { url: image } }, // correct multimodal shape
            ],
          },
        ],
      }),
    });

    const rawText = await oai.text();

    if (!oai.ok) {
      // Surface exact model/access errors to you
      console.error("openai_error", oai.status, rawText.slice(0, 500));
      // Common patterns: 404 model_not_found, 403 access, 401 bad key
      return res.status(oai.status).json({
        error: "openai_error",
        status: oai.status,
        detail: rawText,
        hint:
          oai.status === 404
            ? "Model gpt-5 not found for this API key (no access)."
            : oai.status === 403
            ? "This account is not permitted to use gpt-5."
            : oai.status === 401
            ? "Invalid API key."
            : undefined,
      });
    }

    // Some models wrap JSON in fences; strip cautiously
    let content = rawText.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
    let parsed = safeJson(content);

    // optional repair pass
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
            { role: "system", content: "Return ONLY valid JSON. If input is not valid JSON, repair it. No commentary." },
            { role: "user", content: content },
          ],
        }),
      });
      const fixTxt = await fix.text();
      const fixRaw = fixTxt.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
      parsed = safeJson(fixRaw);
      if (!parsed) {
        console.error("json_repair_failed", fixTxt.slice(0, 500));
        return res.status(502).json({ error: "json_repair_failed", detail: fixTxt.slice(0, 500) });
      }
    }

    if (!parsed || typeof parsed.css !== "string" || typeof parsed.html !== "string") {
      console.error("bad_model_output", content.slice(0, 500));
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
function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }
