export function normalizePublicHttpUrl(value: string, base?: string): string {
  const raw = value.trim();
  if (!raw) throw new Error("URL required");
  if (!base && /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:\/\//i.test(raw)) {
    throw new Error("URL must use http or https");
  }
  const url = new URL(/^https?:\/\//i.test(raw) || base ? raw : `https://${raw}`, base);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("URL must use http or https");
  if (isBlockedFetchHost(url.hostname)) throw new Error("URL host is not allowed");
  url.hash = "";
  return url.toString();
}

export function safeParsedUrl(value: unknown, base: string): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    return normalizePublicHttpUrl(value, base);
  } catch {
    return undefined;
  }
}

export function isBlockedFetchHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return true;
  if (["localhost", "0.0.0.0", "::", "::1"].includes(host)) return true;
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isPrivateIpv4(host);
  if (host.includes(":")) return isPrivateIpv6(host);
  return false;
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isPrivateIpv6(host: string): boolean {
  const ipv4Mapped = ipv4FromMappedIpv6(host);
  if (ipv4Mapped) return isPrivateIpv4(ipv4Mapped);
  return (
    host === "::1" ||
    host.startsWith("fe80:") ||
    host.startsWith("fc") ||
    host.startsWith("fd")
  );
}

function ipv4FromMappedIpv6(host: string): string | null {
  if (!host.startsWith("::ffff:")) return null;
  const suffix = host.slice("::ffff:".length);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(suffix)) return suffix;
  const parts = suffix.split(":");
  if (parts.length !== 2) return null;
  const high = Number.parseInt(parts[0], 16);
  const low = Number.parseInt(parts[1], 16);
  if (![high, low].every((part) => Number.isInteger(part) && part >= 0 && part <= 0xffff)) return null;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}
