import { ReplitConnectors } from "@replit/connectors-sdk";

const connectors = new ReplitConnectors();

export async function stripeRequest<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const form = new URLSearchParams();
  const append = (value: unknown, key: string) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((item, index) => append(item, `${key}[${index}]`));
    else if (typeof value === "object") {
      Object.entries(value as Record<string, unknown>).forEach(([child, item]) =>
        append(item, key ? `${key}[${child}]` : child));
    } else form.append(key, String(value));
  };
  if (body && typeof body === "object") append(body, "");
  const response = await connectors.proxy("stripe", path, {
    method,
    body: method === "GET" || method === "DELETE" ? undefined : form.toString(),
    headers: method === "GET" || method === "DELETE"
      ? undefined
      : { "Content-Type": "application/x-www-form-urlencoded" },
  });
  const result = await response.json() as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(result.error?.message ?? `Stripe request failed (${response.status}).`);
  return result;
}

export async function getStripeClient() {
  const query = (params: Record<string, unknown>) =>
    new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));
  return {
    products: {
      list: (params: Record<string, unknown>) =>
      stripeRequest<{ data: Array<{ id: string; metadata: Record<string, string> }> }>(
        `/v1/products?${query(params)}`),
      create: (body: unknown) => stripeRequest<{ id: string; metadata: Record<string, string> }>("/v1/products", "POST", body),
    },
    prices: {
      list: (params: Record<string, unknown>) =>
        stripeRequest<{ data: Array<{ id: string; metadata: Record<string, string>; currency: string; unit_amount: number | null }> }>(
          `/v1/prices?${query(params)}`),
      create: (body: unknown) => stripeRequest<{ id: string }>("/v1/prices", "POST", body),
    },
    customers: {
      retrieve: (id: string) => stripeRequest<{ id: string; deleted?: boolean }>(`/v1/customers/${encodeURIComponent(id)}`),
      create: (body: unknown) => stripeRequest<{ id: string; deleted?: boolean }>(
        "/v1/customers", "POST", body),
    },
    subscriptions: {
      list: (params: Record<string, unknown>) => stripeRequest<{ data: Array<{
        id: string; status: string; metadata: Record<string, string>; customer: string;
      }> }>(`/v1/subscriptions?${query(params)}`),
    },
    checkoutSessions: {
      retrieve: (id: string) => stripeRequest<{ status: string }>(`/v1/checkout/sessions/${encodeURIComponent(id)}`),
    },
    checkout: { sessions: { create: (body: unknown) =>
      stripeRequest<{ id: string; url: string | null }>("/v1/checkout/sessions", "POST", body) } },
  };
}
