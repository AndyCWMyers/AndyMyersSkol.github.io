export const TIME_ZONE = "America/Los_Angeles";
const dateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const clockFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

export function pacificDate(date = new Date()) {
  const parts = Object.fromEntries(dateFormatter.formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function pacificMidnight(day) {
  const target = Date.parse(day);
  let instant = target;
  // Resolve the zone's offset at local midnight, including DST boundary days.
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(clockFormatter.formatToParts(new Date(instant)).map(part => [part.type, part.value]));
    const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    instant += target - local;
  }
  return instant / 1000;
}

export function pacificDaily(rows) {
  const groups = new Map();
  for (const row of rows) {
    const day = pacificDate(new Date(row.hour)), key = `${day}:${row.kind}`;
    const group = groups.get(key) || { day, kind: row.kind, count: 0 };
    group.count += row.count;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.day.localeCompare(b.day) || a.kind.localeCompare(b.kind));
}
