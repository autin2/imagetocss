import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// Let Stripe verify signatures (raw body needed)
export const config = {
  api: { bodyParser: false },
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(Buffer.from(data)));
    req.on('error', reject);
  });
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY, // server-only!
  { auth: { persistSession: false } }
);

async function setProfileByUserId(userId, patch) {
  const { error } = await supabaseAdmin
    .from('profiles')
    .upsert(
      { id: userId, updated_at: new Date().toISOString(), ...patch },
      { onConflict: 'id' }
    );
  if (error) throw error;
}

async function setProfileByEmail(email, patch) {
  const { data: rows, error: selError } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .ilike('email', email);

  if (selError) throw selError;
  if (rows && rows.length) {
    const { error } = await supabaseAdmin
      .from('profiles')
      .update({ updated_at: new Date().toISOString(), ...patch })
      .eq('id', rows[0].id);
    if (error) throw error;
  }
}

function computeProStatus(sub) {
  const status = sub.status; // 'active','trialing','canceled','past_due','incomplete'
  const pro = status === 'active' || status === 'trialing';
  const pro_until = sub.current_period_end
    ? new Date(sub.current_period_end * 1000).toISOString()
    : null;
  return { pro, status, pro_until };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  let event;
  try {
    const rawBody = await readRawBody(req);
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('⚠️ Webhook signature verification failed', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      // When checkout completes
      case 'checkout.session.completed': {
        const session = event.data.object;
        const subId = session.subscription;
        const sub = subId ? await stripe.subscriptions.retrieve(subId) : null;

        const userId = session.metadata?.userId || sub?.metadata?.userId || null;
        const email = session.customer_details?.email || session.customer_email || null;

        const patch = {
          email: email || null,
          stripe_customer_id: session.customer || sub?.customer || null,
          stripe_subscription_id: sub?.id || null,
        };

        if (sub) {
          const { pro, status, pro_until } = computeProStatus(sub);
          Object.assign(patch, {
            pro, status, pro_until,
            plan: sub.items?.data?.[0]?.price?.id || null
          });
        } else {
          Object.assign(patch, { pro: true, status: 'active' });
        }

        if (userId) await setProfileByUserId(userId, patch);
        else if (email) await setProfileByEmail(email, patch);
        break;
      }

      // Any sub status change
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const userId = sub.metadata?.userId || null;
        const { pro, status, pro_until } = computeProStatus(sub);
        const patch = {
          pro, status, pro_until,
          stripe_customer_id: sub.customer,
          stripe_subscription_id: sub.id,
          plan: sub.items?.data?.[0]?.price?.id || null,
        };

        if (userId) {
          await setProfileByUserId(userId, patch);
        } else {
          const cust = typeof sub.customer === 'string'
            ? await stripe.customers.retrieve(sub.customer)
            : sub.customer;
          const email = cust?.email || null;
          if (email) await setProfileByEmail(email, patch);
        }
        break;
      }

      // Optional: payment failed
      case 'invoice.payment_failed': {
        const inv = event.data.object;
        if (!inv.subscription) break;
        const sub = await stripe.subscriptions.retrieve(inv.subscription);
        const { pro, status, pro_until } = computeProStatus(sub);
        const patch = {
          pro, status, pro_until,
          stripe_customer_id: sub.customer,
          stripe_subscription_id: sub.id,
          plan: sub.items?.data?.[0]?.price?.id || null,
        };

        const userId = sub.metadata?.userId || null;
        if (userId) await setProfileByUserId(userId, patch);
        break;
      }

      default:
        // Ignore the rest
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('⚠️ Webhook handler error:', err);
    return res.status(500).json({ error: 'Webhook handler error' });
  }
}
