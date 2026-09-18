import test from "node:test";
import assert from "node:assert/strict";
import { inboundUrl, inboundDetails, parseInbound } from "../src/inbound.mjs";

test("source URLs retain paths, search terms, UTM variants and click IDs without auth data", () => {
  const value = inboundUrl("https://example.com/papers?q=campaign+finance&utm_content=abstract&utm_term=elections&utm_id=42&gclid=click123&email=a%40example.com&token=secret&next=private#fragment");
  assert.equal(value, "https://example.com/papers?q=campaign+finance&utm_content=abstract&utm_term=elections&utm_id=42&gclid=click123");
  for (const url of ["javascript:alert(1)", "https://user:password@example.com", "not a url", null]) assert.equal(inboundUrl(url), "");
  assert.equal(inboundUrl("https://example.com/me%40example.com?q=safe"), "https://example.com");
  assert.equal(inboundUrl("https://example.com/oauth/secret?q=safe"), "https://example.com");
  assert.equal(inboundUrl("https://example.com/?utm_term=a%40example.com&utm_secret=secret&q=Bearer+secret"), "https://example.com/");
  assert.equal(inboundUrl(value), value, "server sanitization is idempotent");
});

test("source details are bounded, preserve repeated parameters and missing historical values", () => {
  const url = new URL("https://example.com/");
  for (let i = 0; i < 100; i++) url.searchParams.append("utm_content", "a".repeat(100));
  const clean = inboundUrl(url.href);
  assert.ok(clean.length <= 1200);
  assert.ok(new URL(clean).searchParams.getAll("utm_content").length > 1);
  assert.equal(inboundUrl("https://example.com/" + "a".repeat(1400)), "https://example.com");
  assert.equal(parseInbound(null), undefined);
  assert.equal(parseInbound("invalid"), undefined);
  assert.deepEqual(parseInbound(JSON.stringify(inboundDetails("", "https://example.com", "browser"))),
    { referrerUrl: "", landingUrl: "https://example.com/", via: "browser" });
});
