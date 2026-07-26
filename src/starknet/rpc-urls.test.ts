import { describe, it, expect } from "vitest";
import { parseStarknetRpcUrls } from "./rpc-urls.js";

describe("parseStarknetRpcUrls", () => {
  it("returns a single URL unchanged", () => {
    expect(parseStarknetRpcUrls("https://rpc.example/v1")).toEqual(["https://rpc.example/v1"]);
  });

  it("splits comma-separated URLs and trims whitespace", () => {
    expect(parseStarknetRpcUrls("https://a.example/rpc, https://b.example/rpc")).toEqual([
      "https://a.example/rpc",
      "https://b.example/rpc",
    ]);
  });

  it("rejects non-HTTPS endpoints", () => {
    expect(() => parseStarknetRpcUrls("http://rpc.example/v1")).toThrow(/HTTPS/);
  });

  it("rejects an empty list after parsing", () => {
    expect(() => parseStarknetRpcUrls("  ,  ")).toThrow(/at least one/i);
  });
});
