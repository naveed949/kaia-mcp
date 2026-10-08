/**
 * Contract-related tools (Phase 7): read contract, get ABI, get source.
 * read_contract uses viem readContract; get_contract_abi/source use KaiaScan API.
 */

import { createRpcClient } from "../clients/rpc.js";
import { createKaiaScanClient } from "../clients/kaiascan.js";
import { KaiaScanApiError } from "../utils/errors.js";
import {
  encodeCallData,
  parseAbiInput,
  resolveAbiFunction,
  validateAbiFunctionTypes,
  validateAddress,
  validateCallArgs,
  validateFunctionName,
  validateNetwork,
} from "../utils/validation.js";

// --- Tool definitions ---

export const READ_CONTRACT = {
  name: "read_contract",
  description:
    "Read a view/pure contract function (no state change). Requires contract address, function name, and ABI (JSON string or array). Use get_contract_abi first if you do not have the ABI. Returns decoded result as readable text.",
  inputSchema: {
    type: "object" as const,
    properties: {
      contractAddress: { type: "string", description: "Contract address (0x...)" },
      functionName: { type: "string", description: "Name of the function to call" },
      abi: {
        type: "string",
        description:
          "ABI as JSON string or array. If missing, get_contract_abi can be called first to fetch it.",
      },
      args: {
        type: "array",
        description: "Optional array of arguments for the function (in order)",
        items: {},
      },
      network: { type: "string", description: "mainnet or kairos (default: mainnet)" },
    },
    required: ["contractAddress", "functionName", "abi"],
  },
};

export const GET_CONTRACT_ABI = {
  name: "get_contract_abi",
  description:
    "Get the ABI of a verified contract from KaiaScan. Path: GET /api/v1/contracts/:contractAddress/abi. Returns ABI JSON as text.",
  inputSchema: {
    type: "object" as const,
    properties: {
      contractAddress: { type: "string", description: "Contract address (0x...)" },
      network: { type: "string", description: "mainnet or kairos (default: mainnet)" },
    },
    required: ["contractAddress"],
  },
};

export const GET_CONTRACT_SOURCE = {
  name: "get_contract_source",
  description:
    "Get verified contract source code from KaiaScan. Path: GET /api/v1/contracts?contractAddresses=:address (contract info); if source is not available returns 'Unverified'.",
  inputSchema: {
    type: "object" as const,
    properties: {
      contractAddress: { type: "string", description: "Contract address (0x...)" },
      network: { type: "string", description: "mainnet or kairos (default: mainnet)" },
    },
    required: ["contractAddress"],
  },
};

export const CONTRACT_TOOLS = [READ_CONTRACT, GET_CONTRACT_ABI, GET_CONTRACT_SOURCE];

// --- Helpers ---

// --- KaiaScan API response shapes ---

interface ContractListItem {
  address?: string;
  verified?: boolean;
  name?: string;
  symbol?: string;
  type?: string;
  source_code?: string;
  [key: string]: unknown;
}

/** GET api/v1/contracts returns array of contract info */
type GetContractsResponse = ContractListItem[];

// --- Handlers ---

export async function handleReadContract(args: {
  contractAddress?: unknown;
  functionName?: unknown;
  abi?: unknown;
  args?: unknown;
  network?: unknown;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const contractAddress = validateAddress(args.contractAddress);
  const network = validateNetwork(args.network);
  const abi = parseAbiInput(args.abi);
  const functionName = validateFunctionName(args.functionName);
  const callArgs = validateCallArgs(args.args);
  // Encode once up front: a function or argument that does not fit the ABI is the caller's
  // mistake (-32602), found before any RPC call is made.
  const fn = resolveAbiFunction(abi, functionName, callArgs);
  encodeCallData(abi, functionName, callArgs);
  // The result is decoded with the function's `outputs`: a missing or bogus output type is
  // the caller's mistake too, and must be caught here rather than after the RPC returns.
  validateAbiFunctionTypes(fn, { requireOutputs: true });

  const client = createRpcClient(network);
  const result = await client.readContract({
    address: contractAddress,
    abi,
    // The resolved name: viem decodes by name, so encode and decode use the same function.
    functionName: fn.name,
    args: callArgs,
  });

  const text =
    result === undefined || result === null
      ? "null"
      : typeof result === "object"
        ? JSON.stringify(result, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)
        : String(result);

  return {
    content: [{ type: "text" as const, text: `Result:\n${text}` }],
  };
}

export async function handleGetContractAbi(args: {
  contractAddress?: unknown;
  network?: unknown;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const contractAddress = validateAddress(args.contractAddress);
  validateNetwork(args.network);

  const client = createKaiaScanClient();
  const path = `api/v1/contracts/${contractAddress}/abi`;

  let data: unknown;
  try {
    data = await client.get<unknown>(path);
  } catch (err) {
    throw KaiaScanApiError.wrap("contract ABI", err);
  }

  const text =
    typeof data === "string"
      ? data
      : Array.isArray(data)
        ? JSON.stringify(data, null, 2)
        : JSON.stringify(data ?? {}, null, 2);

  return {
    content: [{ type: "text" as const, text }],
  };
}

export async function handleGetContractSource(args: {
  contractAddress?: unknown;
  network?: unknown;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const contractAddress = validateAddress(args.contractAddress);
  validateNetwork(args.network);

  const client = createKaiaScanClient();
  const path = "api/v1/contracts";
  const params = { contractAddresses: contractAddress };

  let data: GetContractsResponse;
  try {
    data = await client.get<GetContractsResponse>(path, params);
  } catch (err) {
    throw KaiaScanApiError.wrap("contract source", err);
  }

  const list = Array.isArray(data) ? data : [];
  const contract =
    list.find((c) => (c?.address ?? "").toLowerCase() === contractAddress.toLowerCase()) ?? list[0];

  if (!contract) {
    return {
      content: [{ type: "text" as const, text: "Unverified" }],
    };
  }

  const source = contract.source_code ?? contract.sourceCode;
  if (source != null && typeof source === "string" && source.trim()) {
    return {
      content: [{ type: "text" as const, text: source.trim() }],
    };
  }

  const verified = contract.verified === true;
  return {
    content: [
      {
        type: "text" as const,
        text: verified
          ? "Verified contract but source code not available via this API."
          : "Unverified",
      },
    ],
  };
}
