/**
 * Where memokit talks to. A `Network` is plain data: pass your own to point at a private RPC,
 * a self-hosted DA Layer or a different XRPL server.
 *
 * Contract addresses are deliberately absent. FdcHub, the request-fee configuration and the
 * Relay are resolved from Flare's Contract Registry at call time, so a Flare redeployment
 * cannot leave this package pointing at a dead address. The registry itself is at the same
 * address on every Flare network.
 */
export interface Network {
  name: string;
  chainId: number;
  /** Flare EVM JSON-RPC endpoint. */
  rpc: string;
  explorer: string;
  /** FDC source id for the XRPL network paired with this Flare network ("testXRP" or "XRP"). */
  sourceId: string;
  /** Data Availability Layer base URL. Needs no API key. */
  daLayerUrl: string;
  contractRegistry: string;
  xrpl: {
    /** rippled JSON-RPC, used to read the payment back. */
    jsonRpc: string;
    /** rippled WebSocket, used to submit it. */
    websocket: string;
    explorer: string;
  };
}

/** Flare's Contract Registry: one address on every Flare network. */
export const CONTRACT_REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";

/** Coston2 (Flare testnet) paired with XRPL Testnet. */
export const COSTON2: Network = {
  name: "coston2",
  chainId: 114,
  rpc: "https://coston2-api.flare.network/ext/C/rpc",
  explorer: "https://coston2-explorer.flare.network",
  sourceId: "testXRP",
  daLayerUrl: "https://ctn2-data-availability.flare.network",
  contractRegistry: CONTRACT_REGISTRY,
  xrpl: {
    jsonRpc: "https://s.altnet.rippletest.net:51234/",
    websocket: "wss://s.altnet.rippletest.net:51233",
    explorer: "https://testnet.xrpl.org",
  },
};

/**
 * Flare mainnet paired with XRPL mainnet. Provided so the same code runs against both; Phase 2
 * exercises it only on a fork, never with a live transaction.
 */
export const FLARE: Network = {
  name: "flare",
  chainId: 14,
  rpc: "https://flare-api.flare.network/ext/C/rpc",
  explorer: "https://flare-explorer.flare.network",
  sourceId: "XRP",
  daLayerUrl: "https://flr-data-availability.flare.network",
  contractRegistry: CONTRACT_REGISTRY,
  xrpl: {
    jsonRpc: "https://xrplcluster.com/",
    websocket: "wss://xrplcluster.com/",
    explorer: "https://livenet.xrpl.org",
  },
};

export const ATTESTATION_TYPE_XRP_PAYMENT = "XRPPayment";

/** Kept for the tests and scripts that predate `Network`. */
export const SOURCE_ID_TESTNET = COSTON2.sourceId;
