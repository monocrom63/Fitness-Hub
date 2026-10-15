import { getStripeClient } from "../src/lib/stripe-client";

const plans = [
  {
    name: "Basis",
    slug: "basis",
    prices: [
      { interval: "monthly", amount: 2990, recurring: { interval: "month" as const, interval_count: 1 } },
      { interval: "semiannual", amount: 17043, recurring: { interval: "month" as const, interval_count: 6 } },
      { interval: "annual", amount: 32292, recurring: { interval: "year" as const, interval_count: 1 } },
    ],
  },
  {
    name: "Premium",
    slug: "premium",
    prices: [
      { interval: "monthly", amount: 4990, recurring: { interval: "month" as const, interval_count: 1 } },
      { interval: "semiannual", amount: 28443, recurring: { interval: "month" as const, interval_count: 6 } },
      { interval: "annual", amount: 53892, recurring: { interval: "year" as const, interval_count: 1 } },
    ],
  },
];

const stripe = await getStripeClient();
const products = await stripe.products.list({ active: true, limit: 100 });
for (const plan of plans) {
  let product = products.data.find(candidate => candidate.metadata.fiudia_tariff === plan.slug);
  if (!product) product = await stripe.products.create({
    name: plan.name,
    description: `Fiudia ${plan.name} membership`,
    metadata: { fiudia_tariff: plan.slug },
  });
  const existingPrices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  for (const planPrice of plan.prices) {
    const exists = existingPrices.data.some(candidate =>
      candidate.metadata.fiudia_interval === planPrice.interval &&
      candidate.currency === "eur" &&
      candidate.unit_amount === planPrice.amount);
    if (exists) continue;
    const created = await stripe.prices.create({
      product: product.id,
      currency: "eur",
      unit_amount: planPrice.amount,
      recurring: planPrice.recurring,
      metadata: { fiudia_interval: planPrice.interval },
    });
    console.log(`${plan.name} ${planPrice.interval}: ${created.id}`);
  }
}
