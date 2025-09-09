// api/generate-css.js
import OpenAI from "openai";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Read JSON body (works in Vercel Node functions)
    let body = "";
    for await (const chunk of req) body += chunk;
    const { image } = JSON.parse(body || "{}");

    if (!image || typeof image !== "string" || !image.startsWith("data:image")) {
      return res.status(400).json({ error: "Send { image: dataUrl }" });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const system = [
      "You are a precise CSS generator.",
      "Given an image of UI or an object, output PRODUCTION-READY CSS ONLY.",
      "Prefer CSS variables under :root for palette & tokens; include utilities (.bg-*, .text-*, .btn-*).",
      "Ensure accessible contrast for text, avoid external fonts, no vendor prefixes, no HTML.",
      "Output must be pure CSS with helpful comments, no Markdown fences."
    ].join(" ");

    const userText = [
      "Analyze this image and produce a complete CSS stylesheet:",
      "- Define :root variables for colors/typography/spacing if visible.",
      "- Provide utilities (.bg-1.., .text-1.., .border-1.., .btn-1..) mapped to tokens.",
      "- Include 1–2 example component blocks (e.g., .card, .badge) styled by tokens.",
      "- Keep it clean and minimal; do not invent wild gradients unless present."
    ].join("\n");

    // Some SDK versions accept a string; others require { url: string } for image_url.
    // If you get "expected an object", switch to { image_url: { url: image } }.
    const resp = await client.responses.create({
      model: "gpt-4o-mini", // vision-capable, fast & inexpensive
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: system + "\n\n" + userText },
          { type: "input_image", image_url: image } // or: { type:"input_image", image_url: { url: image } }
        ]
      }]
    });

    // Helper: get text in a future-proof way
    const text = resp.output_text ?? "";
    // Strip ```css fences if the model added them
    const css = text.replace(/^```(?:css)?\s*/i, "").replace(/```$/i, "").trim();

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ css, raw: text });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to generate CSS." });
  }
}
