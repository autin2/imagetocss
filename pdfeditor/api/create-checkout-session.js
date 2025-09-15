// pages/api/create-checkout-session.js
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2024-06-20",
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { email, userId } = req.body || {};

    // ✅ Env checks (most common reason for FUNCTION_INVOCATION_FAILED)
    const secret = process.env.STRIPE_SECRET_KEY;
    const priceId = process.env.STRIPE_PRICE_ID; // e.g. price_123
    if (!secret || !priceId) {
      return res.status(500).json({
        error:
          "Server misconfigured: set STRIPE_SECRET_KEY and STRIPE_PRICE_ID in your Vercel project env.",
      });
    }

    const origin =
      req.headers.origin ||
      (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000");

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: email || undefined,
      client_reference_id: userId || undefined,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/app.html?checkout=success`,
      cancel_url: `${origin}/pricing.html?canceled=1`,
      allow_promotion_codes: true,
      billing_address_collection: "auto",
      subscription_data: {
        metadata: {
          supabase_user_id: userId || "",
          app: "image-to-css",
        },
      },
      metadata: { started_from: "pricing" },
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("create-checkout-session error:", err);
    return res.status(500).json({
      error:
        err?.message ||
        "Unexpected server error creating checkout session (see function logs).",
    });
  }
}
