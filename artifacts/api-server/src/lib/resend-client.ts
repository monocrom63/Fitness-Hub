import { ReplitConnectors } from "@replit/connectors-sdk";

export type ResendRequest = (url: string, init: RequestInit) => Promise<Response>;

const connectors = new ReplitConnectors();

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("Email provider request timed out."));
      return;
    }
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new Error("Email provider request timed out."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

export const resendRequest: ResendRequest = (url, init) => {
  const target = new URL(url);
  if (target.origin !== "https://api.resend.com") {
    throw new Error("Unexpected email provider URL.");
  }

  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => {
    if (key.toLowerCase() !== "authorization") headers[key] = value;
  });

  return withAbort(connectors.proxy("resend", `${target.pathname}${target.search}`, {
    method: init.method,
    headers,
    body: init.body,
  }), init.signal);
};
