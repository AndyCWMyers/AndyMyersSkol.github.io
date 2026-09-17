import test from "node:test";
import assert from "node:assert/strict";
import { pacificDate, pacificMidnight, pacificDaily } from "../src/time.mjs";
import { reportDates } from "../src/worker.mjs";

test("Pacific reporting observes summer, winter and both DST transitions", () => {
  assert.equal(pacificDate(new Date("2026-09-17T04:00:00Z")), "2026-09-16");
  assert.equal(pacificMidnight("2026-09-16"), Date.parse("2026-09-16T07:00:00Z") / 1000);
  assert.equal(pacificMidnight("2026-01-16"), Date.parse("2026-01-16T08:00:00Z") / 1000);
  for (const [day, hours] of [["2026-03-08", 23], ["2026-11-01", 25]]) {
    const dates = reportDates(new URL(`https://example.org?start=${day}&end=${day}`));
    assert.equal(dates.until - dates.from, hours * 3600);
  }
  assert.notEqual(reportDates(new URL("https://example.org?start=2026-03-09&end=2027-03-09")), null);
  assert.deepEqual(pacificDaily([{ hour: "2026-11-01T08:00:00Z", kind: "page_view", count: 2 }, { hour: "2026-11-01T09:00:00Z", kind: "page_view", count: 3 }]), [{ day: "2026-11-01", kind: "page_view", count: 5 }]);
});
