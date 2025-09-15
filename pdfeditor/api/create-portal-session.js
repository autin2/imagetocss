// Vercel serverless function
import Stripe from 'stripe';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Missing email' });

  try {
    // Try to find an existing customer by email
    const list = await stripe.customers.list({ email, limit: 1 });
    const customer = list.data[0];
    if (!customer) return res.status(404).json({ error: 'No customer found for this email' });

    const portal = await stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: process.env.STRIPE_BILLING_PORTAL_RETURN_URL || `${process.env.SITE_URL}/account.html`
    });

    return res.status(200).json({ url: portal.url });
  } catch (err) {
    console.error('Portal error:', err);
    return res.status(500).json({ error: err.message || 'Stripe error' });
  }
}
