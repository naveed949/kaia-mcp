/**
 * Wallet-related tools (Phase 7): generate keypair, encode function data.
 * No RPC for generate_wallet; encode_function_data is local only.
 *
 * Partner/default mode never returns private keys. `generate_wallet` is omitted from
 * the default tool list and refuses to run unless KAIA_ALLOW_UNSAFE_WALLET=1.
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeFunctionData, type Abi } from "viem";
import { getConfig } from "../config.js";
import { AuthError } from "../utils/errors.js";
import { AUTH_ERRORS } from "../auth/constants.js";

// --- Tool definitions ---

export const GENERATE_WALLET = {
  name: "generate_wallet",
  description:
    "UNSAFE local-dev only: generate a wallet keypair including private key hex. Disabled in partner/default mode. Requires KAIA_ALLOW_UNSAFE_WALLET=1 and scope kaia:wallet.",
  inputSchema: {
    type: "object" as const,
    properties: {
      network: {
        type: "string",
        description: "Optional: mainnet or kairos (for display only)",
      },
    },
    required: [],
  },
};

export const ENCODE_FUNCTION_DATA = {
  name: "encode_function_data",
  description:
    "Encode function call data from ABI, function name, and optional args. Uses viem encodeFunctionData. Returns hex data string. Use for building transaction calldata.",
  inputSchema: {
    type: "object" as const,
    properties: {
      abi: {
        type: "string",
        description: "ABI as JSON string or array (must include the function)",
      },
      functionName: { type: "string", description: "Name of the function" },
      args: {
        type: "array",
        description: "Optional array of arguments (in order)",
        items: {},
      },
    },
    required: ["abi", "functionName"],
  },
};

export const WALLET_TOOLS = [GENERATE_WALLET, ENCODE_FUNCTION_DATA];

// --- Helpers ---

function parseAbiFromInput(abi: unknown): Abi {
  if (abi == null || (typeof abi !== "string" && !Array.isArray(abi))) {
    throw new Error("Invalid ABI: must be a JSON string or an array of ABI items.");
  }
  let parsed: unknown;
  if (typeof abi === "string") {
    const trimmed = abi.trim();
    if (!trimmed) throw new Error("Invalid ABI: empty string.");
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      throw new Error("Invalid ABI: not valid JSON.");
    }
  } else {
    parsed = abi;
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Invalid ABI: must be an array of ABI items.");
  }
  return parsed as Abi;
}

// --- Handlers ---

let generateWalletInvocations = 0;

export function getGenerateWalletInvocationCount(): number {
  return generateWalletInvocations;
}

export function resetGenerateWalletInvocationCount(): void {
  generateWalletInvocations = 0;
}

export async function handleGenerateWallet(args: {
  network?: unknown;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  if (!getConfig().allowUnsafeWallet) {
    throw new AuthError(AUTH_ERRORS.TOOL_DISABLED);
  }

  generateWalletInvocations += 1;

  const network =
    typeof args.network === "string" && args.network.trim().toLowerCase() === "kairos"
      ? "kairos"
      : "mainnet";

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);

  if (typeof console !== "undefined" && console.warn) {
    console.warn(
      "[generate_wallet] Private key was generated. Do not log or expose the private key."
    );
  }

  const lines = [
    `Address: ${account.address}`,
    `Private key (hex): ${privateKey}`,
    `Network (display): ${network}`,
    "",
    "Keep the private key secret. Do not share or commit it.",
  ];

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}

export async function handleEncodeFunctionData(args: {
  abi?: unknown;
  functionName?: unknown;
  args?: unknown;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const abi = parseAbiFromInput(args.abi);

  const functionName = args.functionName;
  if (typeof functionName !== "string" || !functionName.trim()) {
    throw new Error("Invalid functionName: must be a non-empty string.");
  }

  let callArgs: readonly unknown[] | undefined;
  if (args.args !== undefined && args.args !== null) {
    if (!Array.isArray(args.args)) {
      throw new Error("Invalid args: must be an array.");
    }
    callArgs = args.args;
  }

  const data = encodeFunctionData({
    abi,
    functionName: functionName.trim(),
    args: callArgs,
  });

  return {
    content: [{ type: "text" as const, text: data }],
  };
}
