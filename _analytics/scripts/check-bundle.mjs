import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import vm from "node:vm";

// Exercise the delivered script after Wrangler's production transformation.
const built = spawnSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", ".wrangler/smoke"], { stdio: "inherit" });
if (built.status !== 0) process.exit(built.status || 1);
const { default: worker } = await import("../.wrangler/smoke/worker.js");
const listeners = {}, sent = [];
const document = { referrer: "https://example.com/article?q=elections&token=secret", visibilityState: "visible", addEventListener: (name, fn) => { listeners[name] = fn; }, removeEventListener() {} };
const response = await worker.fetch(new Request("https://www.andrewcwmyers.com/__analytics/client.js"), {}, {});
vm.runInNewContext(await response.text(), { document, navigator: { sendBeacon: (url, body) => { sent.push(body); return true; } },
  location: new URL("https://www.andrewcwmyers.com"), URL, Blob, crypto });
listeners.click({ type: "click", target: { closest: () => ({ href: "https://www.wsj.com/article" }) } });
assert.equal(sent.length, 2);
assert.equal(JSON.parse(await sent[0].text()).inbound.referrerUrl, "https://example.com/article?q=elections");
const engagement = await worker.fetch(new Request("https://www.andrewcwmyers.com/__analytics/engagement.js"), {}, {});
const window = {};
vm.runInNewContext(await engagement.text(), { window, document, URL, location: new URL("https://www.andrewcwmyers.com/paper.pdf?utm_content=post&token=secret") });
assert.equal(window.acwInboundDetails().landingUrl, "https://www.andrewcwmyers.com/paper.pdf?utm_content=post");
console.log("Production bundle: standalone page-view and outbound-click script passed.");
