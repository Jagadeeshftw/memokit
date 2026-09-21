/** Coston2 + XRPL Testnet wiring. Overridable by environment for local experiments. */
export const COSTON2 = {
  chainId: 114,
  rpc: process.env.COSTON2_RPC ?? "https://coston2-api.flare.network/ext/C/rpc",
  explorer: "https://coston2-explorer.flare.network",
  /** Read live from the Flare Contract Registry; pinned here for reference only. */
  fdcHub: "0x48aC463d7975828989331F4De43341627b9c5f1D",
  fdcRequestFeeConfigurations: "0x191a1282Ac700edE65c5B0AaF313BAcC3eA7fC7e",
  fdcVerification: "0x906507E0B64bcD494Db73bd0459d1C667e14B933",
  contractRegistry: "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019",
  relay: "0x5017728F117501A24EF9C3756C07f0d564598596",
} as const;

export const XRPL_TESTNET = {
  jsonRpc: process.env.XRPL_RPC ?? "https://s.altnet.rippletest.net:51234/",
  websocket: process.env.XRPL_WS ?? "wss://s.altnet.rippletest.net:51233",
  faucet: "https://faucet.altnet.rippletest.net/accounts",
} as const;

/**
 * The DA Layer is the only off-chain service on the critical path. It needs no API key.
 * The verifier does need one, which is exactly why we do not depend on it: see
 * `src/fdc/encode.ts`, which computes the MIC and the encoded request offline.
 */
export const DA_LAYER = {
  coston2: process.env.DA_LAYER_URL ?? "https://ctn2-data-availability.flare.network",
} as const;

/** Used only by `measure/micOracle.ts` to check our offline encoder. Never in production. */
export const VERIFIER = {
  testnet: "https://fdc-verifiers-testnet.flare.network",
  /** Published by Flare in its own examples; a shared public value, not a credential. */
  publicApiKey: process.env.FDC_VERIFIER_API_KEY ?? "00000000-0000-0000-0000-000000000000",
} as const;

export const ATTESTATION_TYPE_XRP_PAYMENT = "XRPPayment";
export const SOURCE_ID_TESTNET = "testXRP";
