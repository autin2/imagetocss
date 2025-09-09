// Serverless function (Vercel) — generates CSS from an image via OpenAI
// Env: set OPENAI_API_KEY in Vercel > Settings > Environment Variables
import OpenAI from "openai";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Read raw body (Vercel Node functions don't auto-parse JSON)
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body || "{}");
    const image = parsed?.image;

    if (!image || typeof image !== "string" || !/^data:image\/(png|jpe?g|webp);base64,/.test(image)) {
      return res.status(400).json({ error: "Send { image: <dataURL> }" });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY not configured." });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const systemPrompt = [
  "You are a precise CSS generator.",
  "Return **vanilla CSS only** (no Sass/LESS/PostCSS functions).",
  "Use hex colors, :root tokens, and plain CSS selectors.",
  "No Markdown fences. No HTML."
].join(" ");

    const userText = [
      "Analyze this image and produce a complete CSS stylesheet.",
      "Be minimal and clean; if gradients are visible, include them; otherwise avoid.",
      "Prefer hex colors; use comments sparingly to label sections."
    ].join("\n");

    // Use Chat Completions with a vision-capable model
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            { type: "image_url", image_url: { url: image } }
          ]
        }
      ]
    });

    let text = completion?.choices?.[0]?.message?.content || "";
    // Strip accidental ```css fences if present
    text = text.replace(/^```(?:css)?\s*/i, "").replace(/```$/i, "").trim();

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ css: text });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to generate CSS." });
  }
}

