// pages/api/create-portal-session.js
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
    const { email, customerId } = req.body || {};

    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) {
      return res
        .status(500)
        .json({ error: "Server misconfigured: STRIPE_SECRET_KEY not set." });
    }
    if (!email && !customerId) {
      return res.status(400).json({ error: "email or customerId is required." });
    }

    let custId = customerId || null;

    // If no customerId was passed, try to find one by email
    if (!custId && email) {
      const list = await stripe.customers.list({ email, limit: 1 });
      custId = list?.data?.[0]?.id || null;
    }

    if (!custId) {
      return res.status(404).json({
        error:
          "No Stripe customer found for this email. Start a checkout first to create one.",
      });
    }

    const origin =
      req.headers.origin ||
      (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000");

    const portal = await stripe.billingPortal.sessions.create({
      customer: custId,
      return_url: `${origin}/pricing.html`,
    });

    return res.status(200).json({ url: portal.url });
  } catch (err) {
    console.error("create-portal-session error:", err);
    return res.status(500).json({
      error:
        err?.message ||
        "Unexpected server error creating billing portal session (see function logs).",
    });
  }
}
