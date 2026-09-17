// Retain the edge-observed address in D1/private profiles, never GA or aggregates.
function validAddress(value = "") {
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return value.split(".").every(part => Number(part) <= 255) ? value : "";
  if (!value.includes(":") || !/^[0-9a-fA-F:.]{2,45}$/.test(value)) return "";
  try { new URL(`http://[${value}]/`); return value; } catch { return ""; }
}

export function connectingIp(request) {
  const ip = validAddress(request.headers.get("CF-Connecting-IP") || "");
  // In Cloudflare's Pseudo IPv4 overwrite mode, preserve the real IPv6 address.
  if (/^\d+\./.test(ip) && Number(ip.split(".")[0]) >= 240) {
    const ipv6 = validAddress(request.headers.get("CF-Connecting-IPv6") || "");
    if (ipv6.includes(":")) return ipv6;
  }
  return ip;
}
