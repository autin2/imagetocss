import Stripe from 'stripe';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

  // Optional payload from client (helps link to your Supabase user)
  const { email, userId, priceId } = req.body || {};

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      // Use env price unless client explicitly passes a different one
      line_items: [{ price: priceId || process.env.STRIPE_PRICE_ID_MONTHLY, quantity: 1 }],
      success_url: `${process.env.SITE_URL}/app.html?checkout=success`,
      cancel_url: `${process.env.SITE_URL}/pricing.html?checkout=cancel`,
      allow_promotion_codes: true,
      customer_email: email || undefined,
      metadata: userId ? { userId } : {},
      subscription_data: userId ? { metadata: { userId } } : undefined
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    return res.status(500).json({ error: err.message || 'Stripe error' });
  }
}
