import test from "node:test";
import assert from "node:assert/strict";
import { connectingIp } from "../src/ip.mjs";

const request = headers => new Request("https://www.andrewcwmyers.com/", { headers });

test("IP retention accepts only a bounded edge header, with IPv4 and IPv6 support", () => {
  for (const address of ["203.0.113.5", "2001:db8::1", "::ffff:192.0.2.1"]) assert.equal(connectingIp(request({ "CF-Connecting-IP": address })), address);
  for (const address of ["", "999.1.2.3", "not-an-ip", "203.0.113.1, 203.0.113.2", "2001:invalid", "fe80::1%en0", "a".repeat(100)]) assert.equal(connectingIp(request({ "CF-Connecting-IP": address })), "");
  assert.equal(connectingIp(request({ "X-Forwarded-For": "203.0.113.5", "X-Real-IP": "203.0.113.5" })), "");
  assert.equal(connectingIp(request({ "CF-Connecting-IP": "240.0.0.1", "CF-Connecting-IPv6": "2001:db8::1" })), "2001:db8::1");
  assert.equal(connectingIp(request({ "CF-Connecting-IP": "203.0.113.5", "CF-Connecting-IPv6": "2001:db8::1" })), "203.0.113.5");
});
