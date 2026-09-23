/**
 * Import funds from a Flare Smart Accounts personal account into a memokit one.
 *
 * The split-balance problem. A memokit account address depends on the memokit beacon and
 * controller, so the same XRPL address owns a *different* account under each protocol. A user
 * who has used Flare Smart Accounts has FXRP sitting in an FSA account that memokit cannot
 * touch, and no obvious way to move it without an EVM wallet -- which is the thing memokit
 * exists to avoid needing.
 *
 * Flare's own rail solves it. FSA payment-reference instruction `0x01` is "transfer FXRP",
 * and the handler chain is:
 *
 *     Instructions.executeInstruction(type 0, command 1)
 *       -> FXrp.transfer(personalAccount, recipient, amount)
 *         -> personalAccount.transferFXrp(recipient, amount)
 *           -> fAsset.safeTransfer(recipient, amount)
 *
 * Verified against flare-smart-accounts at the deployed commit, and on chain:
 *
 *   source of funds     the FSA personal account's own FXRP balance
 *   recipient           bytes 12..31 of the reference, any non-zero address, no allowlist
 *   amount              bytes 2..11, uint80, in drops -- and FXRP has 6 decimals, so drops
 *                       and FXRP base units are the same number
 *   wallet id           byte 1, not validated on this instruction; only the minting flows
 *                       pass it through to the AssetManager
 *   protocol fee        `receivedAmount >= getInstructionFee(0x01)`, which is 1000 drops on
 *                       Coston2 -- the XRPL carrier payment has to be at least that
 *   who may relay       anyone: `executeInstruction` is external and `notPaused`, with no
 *                       access control. Simulating it from an unrelated EOA reverts with
 *                       `InvalidPaymentAmount`, a validation error, not an authorisation one.
 *                       So memokit does not depend on any particular relayer choosing to
 *                       serve it.
 *
 * So one XRPL payment to the provider wallet registered on Flare's FSA controller, with the
 * recipient set to the user's memokit account, moves the balance across using Flare's rail
 * rather than a bridge of our own.
 *
 * On names: the controller is Flare's because Flare's own Contract Registry names it
 * `MasterAccountController`. The provider wallet is *registered on* that controller -- the
 * `xrplProviderWalletHashes` gate accepts it, and every live import passed that gate. Who holds
 * the wallet's key is not something the chain says, so this code does not say it either.
 */
import { Contract, getAddress, hexlify, type Provider } from "ethers";

/** Flare Smart Accounts' MasterAccountController: the same address on Coston2 and Flare. */
export const FSA_CONTROLLER = "0x434936d47503353f06750Db1A444DBDC5F0AD37c";

/** The XRPL provider wallet registered on the FSA controller, on Coston2. FSA-reference payments go here. */
export const FSA_RECEIVING_COSTON2 = "rEyj8nsHLdgt79KJWzXR5BgF7ZbaohbXwq";

/** FSA instruction id for "FXRP transfer": type 0 (FXRP), command 1 (transfer). */
export const FSA_INSTRUCTION_FXRP_TRANSFER = 0x01;

const FSA_ABI = [
  "function getPersonalAccount(string) view returns (address)",
  "function getInstructionFee(uint256) view returns (uint256)",
  "function getXrplProviderWallets() view returns (string[])",
];

const MEMOKIT_ABI = ["function computeAccountAddress(string) view returns (address)"];

export interface BothAccounts {
  /** The account Flare Smart Accounts derives for this XRPL address. */
  fsa: string;
  /** The account memokit derives for the same XRPL address. */
  memokit: string;
}

/**
 * Both account addresses for one XRPL address.
 *
 * Read from each controller rather than derived locally. FSA's derivation depends on a
 * creation-code constant frozen inside their contract; reproducing it here would be a second
 * copy that can silently disagree with theirs, and the whole point of this helper is to be
 * right about where someone's funds actually are.
 */
export async function deriveBothAccounts(
  xrplOwner: string,
  memokitController: string,
  provider: Provider,
  fsaController: string = FSA_CONTROLLER,
): Promise<BothAccounts> {
  const fsa = new Contract(fsaController, FSA_ABI, provider);
  const memokit = new Contract(memokitController, MEMOKIT_ABI, provider);
  const [fsaAccount, memokitAccount] = await Promise.all([
    fsa.getPersonalAccount(xrplOwner),
    memokit.computeAccountAddress(xrplOwner),
  ]);
  return { fsa: getAddress(fsaAccount), memokit: getAddress(memokitAccount) };
}

export interface ImportReferenceParams {
  /** Amount in drops, which for FXRP equals base units (6 decimals). */
  amountDrops: bigint;
  /** Where the FXRP goes. Normally the user's memokit account. */
  recipient: string;
  /** Byte 1. Not validated by the transfer instruction; defaults to 0. */
  walletId?: number;
}

/**
 * Build the 32-byte FSA payment reference that moves FXRP to `recipient`.
 *
 * Layout, from `PaymentReferenceParser`:
 *
 *     byte  0      instruction id, high nibble type + low nibble command -- 0x01 here
 *     byte  1      wallet id
 *     bytes 2..11  uint80 value, in drops
 *     bytes 12..31 recipient address (20 bytes)
 *
 * The value and recipient fields are adjacent and exactly fill the word; there is no padding
 * to get wrong. FSA rejects a zero value and a zero recipient, so both are checked here
 * rather than being discovered 150 seconds later.
 */
export function buildImportReference(params: ImportReferenceParams): string {
  const { amountDrops, recipient } = params;
  const walletId = params.walletId ?? 0;

  if (amountDrops <= 0n) {
    throw new Error("FSA rejects a zero transfer value (ValueZero)");
  }
  if (amountDrops >= 1n << 80n) {
    throw new Error(`amount ${amountDrops} does not fit the uint80 value field`);
  }
  if (!Number.isInteger(walletId) || walletId < 0 || walletId > 0xff) {
    throw new Error(`walletId is not a byte: ${walletId}`);
  }
  const to = getAddress(recipient);
  if (to === "0x0000000000000000000000000000000000000000") {
    throw new Error("FSA rejects a zero recipient (AddressZero)");
  }

  const out = new Uint8Array(32);
  out[0] = FSA_INSTRUCTION_FXRP_TRANSFER;
  out[1] = walletId;

  let v = amountDrops;
  for (let i = 11; i >= 2; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  out.set(Buffer.from(to.slice(2), "hex"), 12);

  return hexlify(out);
}

/** Inverse of {@link buildImportReference}, for checking a reference before signing it. */
export function decodeImportReference(reference: string): ImportReferenceParams & {
  instructionId: number;
} {
  const bytes = Buffer.from(reference.replace(/^0x/, ""), "hex");
  if (bytes.length !== 32) {
    throw new Error(`an FSA payment reference is exactly 32 bytes, got ${bytes.length}`);
  }
  let amountDrops = 0n;
  for (let i = 2; i < 12; i++) {
    amountDrops = (amountDrops << 8n) | BigInt(bytes[i]);
  }
  return {
    instructionId: bytes[0],
    walletId: bytes[1],
    amountDrops,
    recipient: getAddress("0x" + bytes.subarray(12, 32).toString("hex")),
  };
}

/**
 * Everything needed to sign the import payment.
 *
 * @param minCarrierDrops The XRPL payment must deliver at least the protocol's instruction
 *        fee, read from FSA rather than assumed.
 */
export async function prepareImport(args: {
  xrplOwner: string;
  memokitController: string;
  provider: Provider;
  amountDrops: bigint;
  walletId?: number;
  fsaController?: string;
}): Promise<{
  accounts: BothAccounts;
  reference: string;
  receivingAddress: string;
  minCarrierDrops: bigint;
}> {
  const fsaController = args.fsaController ?? FSA_CONTROLLER;
  const accounts = await deriveBothAccounts(
    args.xrplOwner,
    args.memokitController,
    args.provider,
    fsaController,
  );
  const fsa = new Contract(fsaController, FSA_ABI, args.provider);
  const [minCarrierDrops, wallets] = await Promise.all([
    fsa.getInstructionFee(FSA_INSTRUCTION_FXRP_TRANSFER),
    fsa.getXrplProviderWallets(),
  ]);

  return {
    accounts,
    reference: buildImportReference({
      amountDrops: args.amountDrops,
      recipient: accounts.memokit,
      walletId: args.walletId,
    }),
    receivingAddress: wallets[0],
    minCarrierDrops,
  };
}
