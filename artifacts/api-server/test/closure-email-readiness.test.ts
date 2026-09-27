import assert from "node:assert/strict";
import { test } from "node:test";
import { closureEmailReadiness } from "../src/lib/closure-email";

test("email readiness requires a key and a verified sending domain", async () => {
  const neverFetch = async (): Promise<Response> => {
    throw new Error("Provider must not be contacted without a key");
  };
  assert.match((await closureEmailReadiness("", "mail@fiudia.com", neverFetch)) ?? "", /nicht eingerichtet/);

  const invalidKey = async (): Promise<Response> =>
    new Response(JSON.stringify({ message: "API key is invalid" }), { status: 400 });
  assert.match((await closureEmailReadiness("invalid", "mail@fiudia.com", invalidKey)) ?? "", /nicht versandbereit/);

  const pendingDomain = async (): Promise<Response> =>
    new Response(JSON.stringify({ data: [{ name: "fiudia.com", status: "pending" }] }), { status: 200 });
  assert.match((await closureEmailReadiness("valid", "mail@fiudia.com", pendingDomain)) ?? "", /nicht verifiziert/);

  const verifiedDomain = async (): Promise<Response> =>
    new Response(JSON.stringify({ data: [{ name: "fiudia.com", status: "verified" }] }), { status: 200 });
  assert.equal(await closureEmailReadiness("valid", "mail@fiudia.com", verifiedDomain), null);

  const sendingOnlyKey = async (): Promise<Response> =>
    new Response(null, { status: 403 });
  assert.equal(await closureEmailReadiness("valid", "mail@fiudia.com", sendingOnlyKey), null);
});