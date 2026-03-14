/**
 * Hardcoded list of popular token addresses on Kaia mainnet for kaia://mainnet/tokens/popular.
 */

export interface TokenMeta {
  name: string;
  symbol: string;
  address: string;
}

/** Popular mainnet tokens (name, symbol, contract address). Addresses from Kaia ecosystem. */
export function getPopularMainnetTokens(): TokenMeta[] {
  return [
    { name: "Wrapped KAIA", symbol: "WKAIA", address: "0x0000000000000000000000000000000000000000" },
    { name: "Tether USD", symbol: "USDT", address: "0xcee8faf64ee971a5a3bc6c8ce0ee3a3ef093c717" },
    { name: "USD Coin", symbol: "USDC", address: "0x754288077d0ff82af7a5317c7cb8c444d421d103" },
  ];
}
