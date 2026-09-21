import { COSTON2 as SDK_COSTON2, ATTESTATION_TYPE_XRP_PAYMENT, type Network } from "@memokit/sdk";

/**
 * Coston2 + XRPL Testnet wiring for the scripts. The defaults are the SDK's preset; the
 * environment overrides exist for local experiments (a private RPC, a mirrored DA Layer).
 */
export const NETWORK: Network = {
  ...SDK_COSTON2,
  rpc: process.env.COSTON2_RPC ?? SDK_COSTON2.rpc,
  daLayerUrl: process.env.DA_LAYER_URL ?? SDK_COSTON2.daLayerUrl,
  xrpl: {
    ...SDK_COSTON2.xrpl,
    jsonRpc: process.env.XRPL_RPC ?? SDK_COSTON2.xrpl.jsonRpc,
    websocket: process.env.XRPL_WS ?? SDK_COSTON2.xrpl.websocket,
  },
};

/** Coston2's Relay, pinned for the scripts that read a round before they have a registry handle. */
export const COSTON2 = {
  ...NETWORK,
  relay: "0x5017728F117501A24EF9C3756C07f0d564598596",
} as const;

export const XRPL_TESTNET = {
  ...NETWORK.xrpl,
  faucet: "https://faucet.altnet.rippletest.net/accounts",
} as const;

/** The DA Layer needs no API key. The verifier does, which is why memokit does not use it. */
export const DA_LAYER = { coston2: NETWORK.daLayerUrl } as const;

/** Used only by `measure/micOracle.ts` to check the SDK's offline encoder. Never in production. */
export const VERIFIER = {
  testnet: "https://fdc-verifiers-testnet.flare.network",
  /** Published by Flare in its own examples; a shared public value, not a credential. */
  publicApiKey: process.env.FDC_VERIFIER_API_KEY ?? "00000000-0000-0000-0000-000000000000",
} as const;

export { ATTESTATION_TYPE_XRP_PAYMENT };
export const SOURCE_ID_TESTNET = NETWORK.sourceId;
