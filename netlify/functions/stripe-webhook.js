// netlify/functions/stripe-webhook.js
const stripeLib = require('stripe');

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;       // from Stripe
const STRIPE_SECRET_KEY      = process.env.STRIPE_SECRET_KEY || "";    // optional, only needed if you filter by price IDs
const ALLOWED_PRICE_IDS      = (process.env.ALLOWED_PRICE_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

const IDENTITY_BASE          = process.env.NETLIFY_IDENTITY_URL        // e.g. https://www.beforethebreach.au/.netlify/identity
  || (process.env.URL ? `${process.env.URL}/.netlify/identity` : "");
const IDENTITY_ADMIN_TOKEN   = process.env.NETLIFY_IDENTITY_ADMIN_TOKEN; // Identity Admin API token

// Helper (Node 18+ on Netlify has global fetch; fall back if not)
const fetchX = (...args) => (global.fetch ? fetch(...args) : import('node-fetch').then(({default: f}) => f(...args)));

exports.handler = async (event) => {
  // Stripe signature verification
  const sig = event.headers['stripe-signature'];
  let stripeEvent;
  try {
    const stripe = stripeLib(STRIPE_SECRET_KEY || 'sk_test_placeholder');
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return { statusCode: 400, body: `Webhook error: ${err.message}` };
  }

  // React to successful checkout
  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;

    // Customer email (required for mapping to Identity)
    const email =
      session?.customer_details?.email ||
      session?.customer_email ||
      session?.metadata?.email;
    if (!email) return { statusCode: 200, body: 'No email on session; skipping' };

    // Optional: ensure this is *your* subscriber product (by Stripe price IDs)
    if (ALLOWED_PRICE_IDS.length && STRIPE_SECRET_KEY) {
      const stripe = stripeLib(STRIPE_SECRET_KEY);
      const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 10 });
      const ok = lineItems.data.some(li => li.price?.id && ALLOWED_PRICE_IDS.includes(li.price.id));
      if (!ok) return { statusCode: 200, body: 'Not a subscriber product; ignoring' };
    }

    // Look up the Identity user
    const findRes = await fetchX(`${IDENTITY_BASE}/admin/users?email=${encodeURIComponent(email)}`, {
      headers: { Authorization: `Bearer ${IDENTITY_ADMIN_TOKEN}` }
    });

    let users = [];
    if (findRes.ok) users = await findRes.json();
    const user = Array.isArray(users) && users.length ? users[0] : null;

    // If user doesn't exist, invite with roles
    if (!user) {
      const inviteRes = await fetchX(`${IDENTITY_BASE}/admin/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${IDENTITY_ADMIN_TOKEN}`
        },
        body: JSON.stringify({
          email,
          invite: true,
          app_metadata: { roles: ['member', 'subscriber'] }
        })
      });
      const inviteJson = await inviteRes.json();
      const ok = inviteRes.ok ? 'invited' : `invite_error:${inviteRes.status}`;
      return { statusCode: 200, body: `${ok}:${email} ${JSON.stringify(inviteJson)}` };
    }

    // User exists → add/ensure roles
    const existing = new Set(Array.isArray(user.app_metadata?.roles) ? user.app_metadata.roles : []);
    existing.add('member'); existing.add('subscriber');

    const updateRes = await fetchX(`${IDENTITY_BASE}/admin/users/${user.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${IDENTITY_ADMIN_TOKEN}`
      },
      body: JSON.stringify({ app_metadata: { roles: Array.from(existing) } })
    });

    const updateJson = await updateRes.json();
    const ok = updateRes.ok ? 'updated' : `update_error:${updateRes.status}`;
    return { statusCode: 200, body: `${ok}:${email} ${JSON.stringify({ roles: updateJson.app_metadata?.roles })}` };
  }

  return { statusCode: 200, body: 'ignored' };
};
