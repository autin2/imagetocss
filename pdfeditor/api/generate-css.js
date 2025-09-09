// api/generate-css.js
import OpenAI from "openai";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    let body = "";
    for await (const chunk of req) body += chunk;
    const { image, palette = [] } = JSON.parse(body || "{}");

    if (!image || typeof image !== "string" || !image.startsWith("data:image")) {
      return res.status(400).json({ error: "Send { image: dataUrl, palette?: string[] }" });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const system = [
      "You are a precise CSS generator.",
      "Return VANILLA CSS ONLY (no Sass/LESS functions, no Markdown fences, no HTML).",
      "Structure: :root tokens, utilities (.bg-*, .text-*, .border-*, .btn-*), and 1-2 components (e.g., .header, .hero, .btn-primary).",
      "Prefer high-contrast text; avoid vendor prefixes."
    ].join(" ");

    const paletteNote = palette.length
      ? `Use ONLY these hex colors when possible (pick primaries from them): ${palette.join(", ")}.`
      : `If you infer a palette, keep it minimal (max 5 colors).`;

    const user = [
      "Analyze the attached image and produce a complete stylesheet.",
      paletteNote,
      "Tokens: include --ink (text), --paper (background), and 3-5 brand colors.",
      "Utilities: .bg-1.., .text-1.., .border-1.., .btn-1.. mapped to tokens.",
      "Example components: a large hero heading and a primary button similar to the image."
    ].join("\n");

    const resAI = await client.chat.completions.create({
      model: "gpt-4o-mini",
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

    let css = resAI?.choices?.[0]?.message?.content || "";
    css = css.replace(/^```(?:css)?\s*/i, "").replace(/```$/i, "").trim();

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ css, palette });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to generate CSS." });
  }
}
