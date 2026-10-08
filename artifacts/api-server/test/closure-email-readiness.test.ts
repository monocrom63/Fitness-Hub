import assert from "node:assert/strict";
import { test } from "node:test";
import { closureEmailReadiness } from "../src/lib/closure-email";

test("closure email readiness checks the sender domain through the connected Resend account", async () => {
  let requestUrl = "";
  const invalidConnection = async (url: string, init: RequestInit): Promise<Response> => {
    requestUrl = url;
    assert.equal(init.method, "GET");
    assert.equal(new Headers(init.headers).get("Authorization"), null);
    return new Response(JSON.stringify({ message: "API key is invalid" }), { status: 400 });
  };
  assert.match((await closureEmailReadiness(invalidConnection, "mail@fiudia.com")) ?? "", /nicht versandbereit/);
  assert.equal(requestUrl, "https://api.resend.com/domains");

  const pendingDomain = async (): Promise<Response> =>
    new Response(JSON.stringify({ data: [{ name: "fiudia.com", status: "pending" }] }), { status: 200 });
  assert.match((await closureEmailReadiness(pendingDomain, "mail@fiudia.com")) ?? "", /nicht verifiziert/);

  const verifiedDomain = async (): Promise<Response> =>
    new Response(JSON.stringify({ data: [{ name: "fiudia.com", status: "verified" }] }), { status: 200 });
  assert.equal(await closureEmailReadiness(verifiedDomain, "mail@fiudia.com"), null);

  const sendingOnlyKey = async (): Promise<Response> =>
    new Response(null, { status: 403 });
  assert.equal(await closureEmailReadiness(sendingOnlyKey, "mail@fiudia.com"), null);
});