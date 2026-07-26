/**
 * Parses STARKNET_RPC_URL into one or more HTTPS RPC endpoints (comma-separated).
 */
export function parseStarknetRpcUrls(raw: string): string[] {
  const urls = raw
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u.length > 0);

  if (urls.length === 0) {
    throw new Error("STARKNET_RPC_URL must contain at least one RPC URL");
  }

  for (const url of urls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid Starknet RPC URL: ${url}`);
    }
    if (parsed.protocol !== "https:") {
      throw new Error(`Starknet RPC URLs must use HTTPS (got ${url})`);
    }
  }

  return urls;
}
