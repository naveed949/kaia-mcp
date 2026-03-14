/**
 * Chain definitions for Kaia mainnet and Kairos testnet (Phase 2).
 * Compatible with viem's Chain type.
 * Per Kaia docs: Mainnet chainId 8217, Kairos (testnet) chainId 1001.
 */

import { defineChain } from "viem";

/** Kaia mainnet. Chain ID 8217. */
export const kaiaMainnet = defineChain({
  id: 8217,
  name: "Kaia Mainnet",
  nativeCurrency: {
    name: "KAIA",
    symbol: "KAIA",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ["https://public-en.node.kaia.io"],
    },
  },
  blockExplorers: {
    default: {
      name: "KaiaScan",
      url: "https://kaiascan.io",
    },
  },
});

/** Kaia Kairos testnet. Chain ID 1001 (per docs.kaia.io). */
export const kaiaKairos = defineChain({
  id: 1001,
  name: "Kaia Kairos",
  nativeCurrency: {
    name: "KAIA",
    symbol: "KAIA",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ["https://public-en-kairos.node.kaia.io"],
    },
  },
  blockExplorers: {
    default: {
      name: "KaiaScan Kairos",
      url: "https://kairos.kaiascan.io",
    },
  },
});

export type KaiaNetwork = "mainnet" | "kairos";

/**
 * Returns the viem Chain for the given network.
 */
export function getChain(network: KaiaNetwork) {
  return network === "mainnet" ? kaiaMainnet : kaiaKairos;
}
