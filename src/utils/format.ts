/**
 * Formatting helpers for KAIA and raw peb (Phase 4).
 */

const KAIA_DECIMALS = 18;
const DISPLAY_DECIMALS = 6;

/**
 * Formats raw peb (bigint) as KAIA string with a few decimals (e.g. "1.234567").
 */
export function formatKaia(peb: bigint): string {
  if (peb === 0n) return "0";
  const sign = peb < 0n ? "-" : "";
  const abs = peb < 0n ? -peb : peb;
  const s = abs.toString(10);
  if (s.length <= KAIA_DECIMALS) {
    const padded = s.padStart(KAIA_DECIMALS + 1, "0");
    const intPart = padded.slice(0, -KAIA_DECIMALS);
    const fracPart = padded.slice(-KAIA_DECIMALS).padEnd(KAIA_DECIMALS, "0");
    const fracTrimmed = fracPart.slice(0, DISPLAY_DECIMALS).replace(/0+$/, "") || "0";
    return fracTrimmed === "0" ? `${sign}${intPart}` : `${sign}${intPart}.${fracTrimmed}`;
  }
  const intPart = s.slice(0, -KAIA_DECIMALS);
  const fracPart = s.slice(-KAIA_DECIMALS).slice(0, DISPLAY_DECIMALS).replace(/0+$/, "") || "0";
  return fracPart === "0" ? `${sign}${intPart}` : `${sign}${intPart}.${fracPart}`;
}

/**
 * Formats raw peb as string for display (no decimals).
 */
export function formatPeb(peb: bigint): string {
  return peb.toString(10);
}
