/**
 * What this service must not be holding.
 *
 * An executor needs exactly one secret: an EVM key with enough native balance to pay
 * attestation fees and gas. It does not need an XRPL seed, because it only ever *reads* the
 * XRP Ledger, and it must never be given the key that deployed the contracts, because an
 * executor is a machine on the public internet and a deployer key is an admin key.
 *
 * Intent is not evidence, though. A deployment either holds those or it does not, and the only
 * way to know is to look at the environment the process actually has. So it looks, at boot,
 * reports the result on `/healthz` where anyone can check it, and can be made to refuse to
 * start at all.
 */

/**
 * Variable names that must not be present.
 *
 * Names rather than value shapes. A seed's value is unknowable to this code, but the name it
 * conventionally arrives under is not, and every one of these is a name this repo's own `.env`
 * uses -- which is exactly the accident being guarded against: a deploy that copies the local
 * environment wholesale.
 */
export const FORBIDDEN_ENV = [
  "XRPL_SEED",
  "XRPL_RECEIVING_SEED",
  "MEMOKIT_OWNER_SEED",
  "MNEMONIC",
  "SEED_PHRASE",
  "DEPLOYER_PRIVATE_KEY",
  "XAMAN_API_SECRET",
] as const;

export interface SecretAudit {
  /** Names found in the environment that should not be there. Never their values. */
  present: string[];
  clean: boolean;
  checked: number;
}

export function auditEnvironment(env: NodeJS.ProcessEnv = process.env): SecretAudit {
  const present = FORBIDDEN_ENV.filter((name) => {
    const value = env[name];
    return typeof value === "string" && value.trim().length > 0;
  });
  return { present: [...present], clean: present.length === 0, checked: FORBIDDEN_ENV.length };
}

export class ForbiddenSecretsPresent extends Error {
  constructor(readonly present: string[]) {
    super(
      `This service is configured to refuse to run while it holds secrets it does not need.\n` +
        `Found in the environment: ${present.join(", ")}.\n\n` +
        `An executor needs one secret -- an EVM key that pays fees and gas. It reads the XRP ` +
        `Ledger and never signs for it, so an XRPL seed here can only be a mistake or a leak.\n` +
        `Remove them, or unset REFUSE_IF_SECRETS_PRESENT to run anyway.`,
    );
    this.name = "ForbiddenSecretsPresent";
  }
}
