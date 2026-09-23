# Phase 0 — Investigation Report

**Permissionless general-purpose Flare Smart Accounts rail**
Date: 2026-09-21. All on-chain claims verified live via `cast` against public Flare RPCs on the date above; every address below was read from the Flare Contract Registry or from a deployed contract, not from documentation.

---

## Headline

**Item 1 is positive: FDC Payment attestation requests are permissionless.** Any address can call `requestAttestation` on all four networks; the only gate is the fee. Verified by live simulation from an arbitrary EOA with no prior relationship to Flare.

**But the project's premise needs revising.** The brief assumes Flare's FSA "does this for three hardcoded targets." That is true only of its *32-byte payment-reference* rail. Flare's FSA has a **second rail** — memo opcodes `0xFF`/`0xFE` carrying an ERC-4337 `PackedUserOperation` — which already executes **arbitrary calls** with no target registry. It is deployed on Coston2 **and Flare mainnet**, and it is **actively used in production** (24 `UserOperationExecuted` events in the most recent 250 log entries on mainnet, latest 2026-09-20T23:50Z).

Separately, and more usefully: FAssets now consumes a **new FDC attestation type, `XRPPayment`**, whose response body carries `bytes firstMemoData` — the **full variable-length XRPL memo**, not a 32-byte digest — plus `string sourceAddress` and destination-tag fields. It is registered and permissionlessly requestable on all four networks. This removes the 32-byte ceiling that shapes Flare's existing design and is the single most important finding for your architecture.

Three corrections to premises stated in the brief are noted inline: `isTeeAvailable()` does not exist; FCC is live on Coston **and** Coston2, not Coston2 only; and FSA's entry point is `executeInstruction`, not `executeTransaction`.

---

## 1. FDC permissionlessness (blocking) — **PASS**

### Who may call

`IFdcHub.requestAttestation(bytes calldata _data) external payable`. There is no access control in the interface, and none in practice.

**Live proof.** Simulated `requestAttestation` from `0x1234567890AbcdEF1234567890aBcdef12345678` — an address with no code, no history and no relationship to Flare — with balance override and the exact required fee. Result on **all four networks: success** (`0x` return, no revert).

Control case, same address, `value = 0` on Coston2:
```
execution reverted: fee to low, call getRequestFee to get the required fee amount
```
The fee check is the *only* revert path. No allowlist, no whitelist, no operator role.

### Addresses and fees

| Network | FdcHub | FdcRequestFeeConfigurations |
|---|---|---|
| Flare | `0xc25c749DC27Efb1864Cb3DADa8845B7687eB2d44` | `0x259852Ae6d5085bDc0650D3887825f7b76F0c4fe` |
| Songbird | `0xCfD4669a505A70c2cE85db8A1c1d14BcDE5a1a06` | `0x8998a3b85350aA4CA5f55cD80ab1f7C9C0ddf02C` |
| Coston | `0x1c78A073E3BD2aCa4cc327d55FB0cD4f0549B55b` | `0x2bBfb46aC3A71A6725699004B8a8fE4C928E7108` |
| Coston2 | `0x48aC463d7975828989331F4De43341627b9c5f1D` | `0x191a1282Ac700edE65c5B0AaF313BAcC3eA7fC7e` |

Fees via `getRequestFee(bytes)`, paid in the **native token** (FLR/SGB/C2FLR/CFLR):

| attestationType / sourceId | Flare | Songbird | Coston | Coston2 |
|---|---|---|---|---|
| `Payment` / `XRP` | **20 FLR** | **1 SGB** | — | — |
| `Payment` / `testXRP` | — | *not supported* | **1000 wei** | **1000 wei** |
| `XRPPayment` / `XRP` | **20 FLR** | **20 SGB** | — | — |
| `XRPPayment` / `testXRP` | — | — | **1000 wei** | **1000 wei** |

The registry is genuine, not a permissive default: a bogus type reverts with `Type and source combination not supported`.

Fee economics matter. Confirmed requests pay data providers; unconfirmed requests are **burnt**. A larger fee raises the chance of confirmation in-round.

### Verifier and DA Layer — the real (soft) gate

This is the one place where access is not fully open, and it is worth stating precisely because it is the only qualification on the item-1 pass.

**Verifier servers are API-keyed.** Without a key:
```
POST https://fdc-verifiers-testnet.flare.network/verifier/xrp/Payment/prepareRequest  → HTTP 401
POST https://fdc-verifiers-mainnet.flare.network/verifier/xrp/Payment/prepareRequest  → HTTP 401 {"message":"Unauthorized"}
```
With the public key `00000000-0000-0000-0000-000000000000`, **both testnet and mainnet return HTTP 200**. So the key is a shared public value, not an allowlist — but it is Flare-operated and revocable.

Crucially, **the verifier is a convenience, not a dependency**: it prepares the encoded request and the MIC, both of which can be computed offline. It is not in the trust path.

**The DA Layer is not authenticated.** All four respond without any key, returning a semantic error rather than 401:
```
ctn2-data-availability.flare.network  → 400 {"error":"attestation request not found"}
ctn-data-availability.flare.network   → 400
flr-data-availability.flare.network   → 400
sgb-data-availability.flare.network   → 400
```
Flare's docs state operating a DA Layer is permissionless — anyone can run one from a Flare Entity.

**Rate limits: unquantified.** Flare's docs describe "a rate-limited public endpoint" and advise self-hosting for production, but publish no numbers. Treat this as an operational unknown to measure in Phase 1, not a blocker.

### Verdict

Not gated. Proceed. The residual risks are economic (20 FLR/request on mainnet) and operational (public verifier key, unmeasured rate limits), both mitigable by self-hosting.

---

## 2. Flare's FSA implementation

Repo: `github.com/flare-foundation/flare-smart-accounts`. The brief's `MasterAccountController.executeTransaction` does not exist. There are **two independent rails** with different trust models, different memo encodings, and different permissioning.

### Rail A — proof flow (32-byte payment reference)

Entry point: `executeInstruction(IPayment.Proof calldata, string calldata _xrplAddress) external payable` — selector `0x6ac2d568`, live on Coston2 and Flare mainnet.
Also `reserveCollateral(string,bytes32,bytes32)` (`0x1add812b`) and `executeDepositAfterMinting(uint256,IPayment.Proof,string)` (`0xa01b2757`).

**Anyone may call these** — they are `external payable` with only a `notPaused` modifier. The relayer role is open.

#### Byte layout (32 bytes)

```
 byte:  0    1    2                              11 12  13 14  15                          31
       +----+----+--------------------------------+------+------+--------------------------+
       | id | wid|        value (uint80)          | agt  | vlt  |  unused (16 bytes)       |
       +----+----+--------------------------------+------+------+--------------------------+
                                                   └─────────── FXRP transfer (id 0x01):
                                                                bytes 12–31 = recipient (address, 20 bytes)
```

| Field | Bytes | Width | Decoder |
|---|---|---|---|
| instruction id | 0 | 8 bits | `>> 248` |
| — instruction **type** | 0 hi nibble | 4 bits | `>> 252` |
| — instruction **command** | 0 lo nibble | 4 bits | `(>> 248) & 0x0F` |
| wallet identifier | 1 | 8 bits | — |
| value | 2–11 | **uint80** | `(>> 160) & (2^80-1)`, must be non-zero |
| agentVaultId | 12–13 | uint16 | `(>> 144) & 0xFFFF`, non-zero |
| vaultId | 14–15 | uint16 | `(>> 128) & 0xFFFF`, non-zero |
| recipient address | 12–31 | 160 bits | `& (2^160-1)`, non-zero — **overlaps** agt/vlt |

Amounts are **not** scaled: `value` is drops for transfers/deposits, whole **lots** for mint/redeem, a period index for claim-withdraw, and a `yyyymmdd` integer for Upshift claim. FXRP has 6 decimals; lot size is `1e7` (10 FXRP) on both Flare and Coston2.

Instruction table (type = high nibble):

| id | Type / command | Value means | Other fields |
|---|---|---|---|
| `0x00` | FXRP / collateral reservation | lots | 12–13 agent vault id |
| `0x01` | FXRP / transfer | drops | 12–31 recipient |
| `0x02` | FXRP / redeem | lots | — |
| `0x10` | Firelight / mint+deposit | lots | 12–13 agent, 14–15 vault |
| `0x11` | Firelight / deposit | drops | 14–15 vault |
| `0x12` | Firelight / redeem | shares | 14–15 vault |
| `0x13` | Firelight / claim withdraw | period | 14–15 vault |
| `0x20` | Upshift / mint+deposit | lots | 12–13 agent, 14–15 vault |
| `0x21` | Upshift / deposit | drops | 14–15 vault |
| `0x22` | Upshift / request redeem | shares | 14–15 vault |
| `0x23` | Upshift / claim | `yyyymmdd` | 14–15 vault |

#### Proof validation (`PaymentProofs.verifyPayment`)

Five checks, then the FDC call:

1. `proof.data.sourceId == state.sourceId` (configured per chain)
2. `responseBody.status == 0`
3. `block.timestamp <= validityDuration + responseBody.blockTimestamp` — **7200 s on Flare, 86400 s on Coston2**
4. `responseBody.sourceAddressHash == keccak256(bytes(_xrplAddress))` — binds the proof to the claimed XRPL owner
5. `xrplProviderWalletHashes[responseBody.receivingAddressHash] != 0` — **← the gate you would remove**
6. `ContractRegistry.getFdcVerification().verifyPayment(proof)`

Check 5 is the whole permissioning story of Rail A. The XRPL Payment must land on a provider wallet registered on the controller, and there is exactly **one** per chain. *(Corrected 2026-09-23: this originally said "Flare-operated". The chain shows the wallet is registered on Flare's controller; it does not show who holds its key.)*

| Network | XRPL provider wallet | sourceId (read on-chain) |
|---|---|---|
| Flare | `rM2LEysS4isvAJkZFfxKDL5z4aTfWcBTXV` | `XRP` |
| Coston2 | `rEyj8nsHLdgt79KJWzXR5BgF7ZbaohbXwq` | `testXRP` |

Nothing about FDC forces this — it is FSA policy. Your deployment sets its own list.

#### Account derivation

Deterministic CREATE2 through the **EIP-2470 Singleton Factory** at `0xce0042B868300000d44A59004Da54A005ffdcf9f`, salt `bytes32(0)`:

```
address = CREATE2(SINGLETON_FACTORY, 0, keccak256(PROXY_CREATION_CODE ‖ abi.encode(diamond, xrplOwnerString)))
```

`PROXY_CREATION_CODE` is a **frozen bytecode constant** (not `type(...).creationCode`) so the derivation cannot drift when unrelated source files change; a test fixture asserts its hash. The account is a `BeaconProxy` whose **beacon is the diamond itself**. `getOrCreatePersonalAccount(string)` deploys on first use and caches in `mapping(string => IIPersonalAccount)`.

Consequence worth noting: because the diamond address is inside the initcode, **your diamond derives a different account address for the same XRPL owner**. No collision with Flare's accounts — but also no shared balance. See risk 7.

Execution target on the account: `executeUserOp(Call[] calldata)` where `Call = {address target; uint256 value; bytes data}` — `onlyController`, `nonReentrant`. This is already a general multicall.

### Rail B — memo flow (direct minting) — **already arbitrary-call**

Entry point: `handleMintedFAssets(bytes32 _transactionId, string _sourceAddress, uint256 _amount, uint256 _underlyingTimestamp, bytes _memoData, address payable _executor, bytes _data)` — selector `0x8d32d9fd`, **deployed on Coston2 and Flare mainnet**, guarded by `onlyAssetManager`.

It is reached only via FAssets `executeDirectMintingWithData(IXRPPayment.Proof, bytes)`, which the AssetManager calls back into. So Rail B is **coupled to FXRP minting**: the XRPL payment must mint FXRP before any instruction runs.

**Memo layout — 10-byte header, common to all seven opcodes:**

```
byte:  0        1                 2..9
       opcode   walletId (uint8)  executorFee (uint64, big-endian)
```

| Opcode | Payload after header | Exact length | Effect |
|---|---|---|---|
| `0xFF` | `abi.encode(PackedUserOperation)` | variable | Execute UserOp inline from the memo |
| `0xFE` | `bytes32 keccak256(_data)` | **42** | Execute UserOp supplied out-of-band in `_data` |
| `0xE0` | `bytes32 targetTxId` | **42** | Ignore a stuck memo (recovery) |
| `0xE1` | `uint256 newNonce` | **42** | Bump nonce (strictly up, ≤ `uint32` jump) |
| `0xE2` | `bytes32 targetTxId` + `uint64 newFee` | **50** | Override executor fee, stored `+1` |
| `0xD0` | `address newExecutor` | **30** | Pin a per-account executor |
| `0xD1` | *(none)* | **10** | Clear the pin |

`0xFF`/`0xFE` honour only three UserOp fields — `sender`, `nonce`, `callData` — and then run `personalAccount.call{value: msg.value}(userOp.callData)`. Since the diamond is the controller, this satisfies `onlyController` and reaches `executeUserOp(Call[])`. **That is an unrestricted arbitrary call.** There is no target registry on this path.

Safety notes worth carrying into your design:
- No `try/catch` around dispatch — a reverting UserOp unwinds the whole direct mint, including the `usedTransactionIds` mark. Replay state stays consistent with outcomes, but the user is left with an irreversible XRPL Payment that cannot execute. `0xE0`/`0xE1`/`0xE2` exist purely to unstick this.
- **Destination tags are forbidden** on this path — a third party can buy the tag on the direct-minting facet and front-run the user.
- Replay protection is shared: `Instructions.State.usedTransactionIds` is written by both rails, so one XRPL transaction can never drive two actions.
- The memo nonce is separate and advances only on successful `0xFF`/`0xFE`.

**Direct-minting limits (read on-chain)** — these bound Rail B and would bound you if you depend on it:

| Setting | Flare | Coston2 |
|---|---|---|
| `getDirectMintingOthersCanExecuteAfterSeconds` | 7200 | 7200 |
| `getDirectMintingExecutorFeeUBA` | 200000 (0.2 FXRP) | 100000 |
| `getDirectMintingMinimumFeeUBA` | 100000 | 100000 |
| `getDirectMintingFeeBIPS` | 10 | 25 |
| `getDirectMintingHourlyLimitUBA` | 4e12 (4M FXRP) | 1e11 |
| `getDirectMintingDailyLimitUBA` | 4e13 (40M FXRP) | 5e11 |
| `getDirectMintingLargeMintingThresholdUBA` | 4e12 | 1e11 |

Note `OthersCanExecuteAfterSeconds = 7200`: a designated executor has a 2-hour exclusivity window, after which **anyone** may execute. So Rail B is permissionless with a 2-hour delay.

### The `XRPPayment` attestation type — the important discovery

`executeDirectMintingWithData` does **not** take the classic `IPayment.Proof`. It takes `IXRPPayment.Proof`, a distinct FDC attestation type:

```
RequestBody  { bytes32 transactionId; address proofOwner; }
ResponseBody { uint64 blockNumber; uint64 blockTimestamp;
               string  sourceAddress;                 ← full address, not just a hash
               bytes32 sourceAddressHash; bytes32 receivingAddressHash;
               bytes32 intendedReceivingAddressHash;
               int256  spentAmount; int256 intendedSpentAmount;
               int256  receivedAmount; int256 intendedReceivedAmount;
               bool    hasMemoData;
               bytes   firstMemoData;                 ← FULL VARIABLE-LENGTH MEMO
               bool    hasDestinationTag; uint256 destinationTag;
               uint8   status; }
```

Verified live:
- Registered and priced on all four networks (table in item 1).
- `requestAttestation` with an `XRPPayment` request from an arbitrary EOA on Coston2: **succeeds**.
- `verifyXRPPayment(...)` is live on the deployed `FdcVerification` on **both Flare mainnet** (`0x5C14FE9D73Ab763F4d4a76f334bf7029DDD20Ecc`) **and Coston2** (`0x906507E0B64bcD494Db73bd0459d1C667e14B933`) — returns `false` for an all-zero proof rather than reverting with `FunctionNotFound`, confirming the selector is wired.

**This means you are not limited to 32 bytes.** You can carry a full instruction — up to XRPL's memo ceiling — through FDC, permissionlessly, without touching FAssets direct minting. That is the technical core of a general-purpose rail and it did not exist in the design the brief assumes.

Caveat: I found no public developer-hub page documenting `XRPPayment`. It is in the published `@flarenetwork/flare-periphery-contracts` package (v0.1.53) and live on chain, but treat it as a newer, less-documented surface (risk 5).

### Diamond, modules, pause, timelock

EIP-2535 diamond. `MasterAccountController` is at the **same address on all three chains where it exists**: `0x434936d47503353f06750Db1A444DBDC5F0AD37c`.

| | Coston2 | Flare | Songbird |
|---|---|---|---|
| Facet addresses | 18 | — | 18 |
| Public selectors | **74** | **59** | subset |
| Relationship | strict superset of Flare | — | memo-only |

Facets: `DiamondCut`, `DiamondLoupe`, `Ownership`, `AgentVaults`, `Executors`, `InstructionFees`, `Instructions`, `MemoInstructions`, `PaymentProofs`, `PersonalAccounts`, `Pause`, `Reader`, `Timelock`, `Vaults`, `XrplProviderWallets`, `MasterAccountControllerInit`.

- **Pause** — `PauseFacet` with distinct pauser/unpauser sets. Flare mainnet has 3 pausers, 2 unpausers. All instruction entry points carry `notPaused`.
- **Timelock** — `OwnableWithTimelock`, **3600 s** on both Flare and Coston2. Economic changes (`setExecutorFee`, all instruction-fee setters) are `onlyOwnerWithTimelock`; `setExecutor` is `onlyOwner` **without** timelock, deliberately, so a compromised executor key can be rotated immediately.
- **Executors** — three distinct concepts: (1) one global protocol executor paid in **wei**, (2) a per-account pinned executor paid in **fAsset units**, set via `0xD0`/`0xD1`, (3) a pass-through parameter to the FAssets AssetManager. Live values: Flare `0x02954e158Be2b477E1C26F31e8AA0c21b378445C` @ 10 FLR; Coston2 `0x103b384064ae85577127097A7cCadfd6fb13f437` @ 1e11 wei.
- **Instruction fees** — stored **1-based** (`0` = unset → use default; `n+1` = override of `n`), so a fee can be explicitly waived. Defaults: Flare `500000` (0.5 FXRP) with `950000` overrides on ids 0, 2, 16, 32; Coston2 `1000`.

### Reserved space — yes, ample

**Rail A (32-byte reference).** The high nibble partitions 16 namespaces and only **3 are used** (`0x0`, `0x1`, `0x2`). Types `0x3`–`0xF` — 13 of 16 — are entirely free, and `Instructions.executeInstruction` reverts `InvalidInstruction` on anything unlisted, so there is no silent-misparse hazard. Within type `0x0`, commands `0x3`–`0xF` are free. For every non-transfer shape, **bytes 16–31 (16 bytes) are unused**.

**Rail B (memo opcodes).** Seven of 256 opcode values are taken. `0xFD` and `0xFC` sit immediately adjacent to Flare's execute band and are free; so are `0xD2`–`0xDF` and `0xE3`–`0xFB`.

You can be wire-compatible in both channels without collision.

---

## 3. Live network state

Flare Contract Registry is at `0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019` on **all four** networks. Read via `getAllContracts()`.

| Contract | Coston | Coston2 | Songbird | Flare |
|---|---|---|---|---|
| **FdcHub** | `0x1c78A073E3BD2aCa4cc327d55FB0cD4f0549B55b` | `0x48aC463d7975828989331F4De43341627b9c5f1D` | `0xCfD4669a505A70c2cE85db8A1c1d14BcDE5a1a06` | `0xc25c749DC27Efb1864Cb3DADa8845B7687eB2d44` |
| **FdcVerification** | `0x30DAB57c409E1e18c8B00dC351Bf568953D607B1` | `0x906507E0B64bcD494Db73bd0459d1C667e14B933` | `0x3f4dd62410D4F876232Ed17C115437144995557f` | `0x5C14FE9D73Ab763F4d4a76f334bf7029DDD20Ecc` |
| **Fdc2Hub (V2)** | `0x064C7B68B0e2BC87e7bE34e89741485Fcb48FA2F` | `0x04dd3Ba33aC798d400bEc42A26F82f9812A421dc` | — | — |
| **Fdc2Verification** | `0x21D3842E39A3b62ba15CD8A5D2ED5cEDea931502` | `0xA34Ff9be42b2C7782786270a51d33b1baC0462Cd` | — | — |
| **FtsoV2** | `0x787C2AbB211dbC5F9B239288701a3dd5ae3Af1A2` | `0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d` | `0x510600336247303f9dAA337eC7E82D1F11462Ec8` | `0x7BDE3Df0624114eDB3A67dFe6753e62f4e7c1d20` |
| **AssetManagerFXRP** | `0x56728e46908fB6FcC5BCD2cc0c0F9BB91C3e4D34` | `0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA` | `0x299d678f67e7ADD4efdf295Ebe0E92FCb4f75C4c` | `0x2a3Fe068cD92178554cabcf7c95ADf49B4B0B6A8` |
| **MasterAccountController** | — | `0x434936d4…AD37c` (full) | `0x434936d4…AD37c` (unregistered, stub) | `0x434936d4…AD37c` (full) |
| **FlareTeeManager** | `0xc4885998f5D792ed88C5Af7a3AaCBe333f017658` | `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE` | — | — |

### Two corrections to the brief's premises

**(i) `isTeeAvailable()` does not exist.** `FlareTeeManager` is itself an **EIP-2535 diamond** (identical proxy bytecode on Coston and Coston2). Every call to `isTeeAvailable()` reverts with the standard diamond error `FunctionNotFound(bytes4)` (`0x5416eb98`) echoing the queried selector `0xc2af3481` — i.e. the function is simply not in the selector set. Confirmed by enumerating all **198 selectors** via `facets()`; there is no availability boolean anywhere in it.

The nearest real equivalents, called live:

| | Coston | Coston2 |
|---|---|---|
| `getActiveTeeMachines(0)` | `[]` — **empty** | **3 machines** (`0x6f489B49…`, `0xAfcde9Fb…`, `0x9395cF48…`) |
| `getAllActiveTeeMachines(0,50)` | long list | long list |
| `getDefaultFee()` | 1000 | 1000 |
| `getMachinePathListsCount(0)` | 6 | 3 |
| `nextPublicExtensionId()` | 65655 | 67172 |

The diamond is a full TEE-machine registry with wallets, extensions, versioned machine-path lists and governance — functions like `createWallet(bytes32)`, `getWalletStatus(bytes32)`, `confirmAvailability(...)`, `getTeeMachineStatus(address)`, `requestAvailabilityCheckAttestation(...)`.

**(ii) FCC is on Coston *and* Coston2, not Coston2 only.** Both have registered, functional `FlareTeeManager` contracts. Coston2 additionally has active machines for extension 0; Coston's active set for that extension is empty. Neither Songbird nor Flare mainnet has it. The brief's "Songbird approved by governance but no published addresses" holds — no `FlareTeeManager` in the Songbird registry. "Not yet a fully public production system" also holds: no ABI is published in the periphery package, which is why selector enumeration was required.

### Songbird's FSA is a dormant stub

`0x434936d4…AD37c` on Songbird **has code and 18 facets**, but is absent from the Contract Registry and is functionally incomplete: `getSourceId()`, `paused()`, `getDefaultInstructionFee()`, `getExecutorInfo()` and `getXrplProviderWallets()` all revert `FunctionNotFound`. The proof-flow facets were never cut in. Total lifetime activity: **3 transactions** (`executeTimelockedCall` ×2, `transferOwnership` ×1), last on 2026-07-07.

### Activity (both rails, live)

| Network | Total txs to MAC | Latest | Recent methods |
|---|---|---|---|
| Coston2 | **162,397** | 2026-09-20T23:44Z | `executeInstruction`, `reserveCollateral` |
| Flare | **73,426** | 2026-09-20T23:49Z | `executeDepositAfterMinting`, `executeInstruction`, `reserveCollateral` |
| Songbird | 3 | 2026-07-07 | governance only |

Event histogram over the most recent 250 log entries:

| Event | Coston2 | Flare |
|---|---|---|
| `InstructionExecuted` | 100 | 71 |
| `CollateralReserved` | 42 | 40 |
| `FXrpRedeemed` | 61 | 17 |
| `Deposited` | 12 | 31 |
| **`DirectMintingExecuted`** | **5** | **27** |
| **`UserOperationExecuted`** | **2** | **24** |

Rail B is not theoretical. A sampled mainnet UserOp (`0x076739ec…f2bce`, 2026-09-20T23:50Z) shows the full path working: executor `0x02954e15…` calls `executeDirectMintingWithData` on the AssetManager → 33.98 FXRP minted → 0.2 FXRP executor fee → 33.78 FXRP to the personal account `0x63193962…` → UserOp deposits it into Upshift vault `0x2439D4bb…`, minting MXRPY shares.

### Most complete network

**Coston2** — the only network carrying FDC **and** FDC V2 **and** FTSOv2 **and** FAssets **and** a full FSA **and** FCC.

---

## 4. Target protocols for reference integrations

Checked on Coston2 (item 3's most complete network) and compared against Flare mainnet. `code size = 3` means the RPC returned literally `0x` — **no contract**.

| Protocol | Category | Address | Flare mainnet | **Coston2** |
|---|---|---|---|---|
| Kinetic Unitroller | Lending | `0x8041680Fb73E1Fe5F851e76233DCDfA0f2D2D7c8` | 3,019 B ✅ | **absent** |
| Kinetic Comptroller | Lending | `0xeC7e541375D70c37262f619162502dB9131d6db5` | 49,007 B ✅ | **absent** |
| Morpho | Lending | `0xF4346F5132e810f80a28487a79c7559d9797E8B0` | 31,167 B ✅ | **absent** |
| SparkDEX V3Factory | DEX | `0x8A2578d23d4C532cC9A98FaD91C0523f5efDE652` | 49,155 B ✅ | **absent** |
| SparkDEX UniversalRouter | DEX | `0x0f3D8a38D4c74afBebc2c42695642f0e3acb15D3` | 35,919 B ✅ | **absent** |
| OpenOcean Router V2 | DEX aggregator | `0x6352a56caadC4F1E25CD6c75970Fa768A3304e64` | 4,325 B ✅ | **absent** |

**Every lending market and every DEX is mainnet-only. Coston2 has none of them.** Mystic is a front-end for Morpho on Flare, not a separate deployment.

Kinetic main-market liquidity on Flare (`getCash()`), for sizing:

| kToken | Address | Underlying | Cash |
|---|---|---|---|
| kUSDC.e | `0xDEeBaBe05BDA7e8C1740873abF715f16164C29B8` | `0xFbDa5F67…` | **183,019 USDC.e** |
| kUSDT0 | `0x76809aBd690B77488Ffb5277e0a8300a7e77B779` | `0xe7cd86e1…` | **437,105 USDT0** |
| kFLR | `0xb84F771305d10607Dd086B2f89712c0CeD379407` | native | **≈163.7M FLR** |

### ERC-4626 on Coston2 — this one *does* work

All four FSA-registered Coston2 vaults are live, standard ERC-4626, and **hold real balances**. Underlying is `FTestXRP` `0x0b6A3645c240605887a5532109323A3E12273dc7` (6 decimals, total supply **9,150,574.01**).

| Vault | Name | totalAssets | totalSupply |
|---|---|---|---|
| `0xF97B2bBdB2f4a561806e5038a503eCA81554634E` | TESTearnXRP | **6,209.45** | 6,202.63 |
| `0x9E63a5D282F2fBb7DcE822B98e363b2719D28319` | TESTearnXRP | **9,622.67** | 9,085.08 |
| `0x4066A1363a04ce3B23eEcB53dEfa65f94A24355E` | TESTstXRP | **1,848.20** | 1,848.20 |
| `0xD91324A6e8884147F6425E9ddd60e11Aea060B5b` | TESTstXRP | **61.90** | 61.90 |

On Flare mainnet, `Firelight stXRP` `0x4C18Ff3C89632c3Dd62E796c0aFA5c07c4c1B2b3` holds **50,791,492.98 FXRP** (FXRP total supply 145,576,326.94). The two Upshift vaults (`0x373D7d20…`, `0x2439D4bb…`) are **not** standard ERC-4626 — `name()` and `totalAssets()` revert. Do not assume a uniform vault interface.

### Concrete conclusion

The brief predicted testnet liquidity would be the failure point. **It is — but only for two of the three categories.** On Coston2 you can build and demo a real ERC-4626 integration against funded vaults. You **cannot** demo a lending market or a DEX swap on Coston2 at all, because neither exists there at any liquidity level. Those two reference integrations must either run against Flare mainnet, or against a mainnet fork, or be dropped from the v1 demo scope.

---

## 5. XRPL side

**Pairing.** `testXRP` = **XRPL Testnet**, pairs with Coston and Coston2. `XRP` = XRPL Mainnet, pairs with Songbird and Flare. Confirmed on-chain: FSA's configured `sourceId` is `testXRP` on Coston2 and `XRP` on Flare.

**Devnet is not supported.** FDC exposes only these two XRPL sourceIds; there is no Devnet source. If you need Devnet, FDC cannot attest it.

**Does FDC attest XRPL Testnet payments?** Yes — both `Payment`/`testXRP` and `XRPPayment`/`testXRP` are registered and priced at 1000 wei on Coston and Coston2, and an arbitrary EOA can request them (item 1).

### Memo size and encoding constraints

- **rippled caps the entire serialized `Memos` array at 1024 bytes.** With a single `MemoData` and no `MemoType`/`MemoFormat`, roughly **1,019 bytes** of payload survive serialization. Adding an 11-byte `MemoType` tag can push past the cap and the transaction fails local checks.
- **`Payment` attestation — hard 32-byte limit.** A transaction has a `standardPaymentReference` only if it has **exactly one Memo** whose `memoData` is a hex string representing **exactly 32 bytes**. Anything else yields no reference. This is brittle: a wallet that helpfully adds a `MemoType` or `MemoFormat` silently breaks the reference.
- **`XRPPayment` attestation — no such limit.** Returns `bytes firstMemoData` verbatim. Practical ceiling is XRPL's ~1,019 bytes, minus your header.

### Memos vs destination tags

Flare's operator uses **memos, and explicitly forbids destination tags** on the smart-account path. From the spec:

> XRPL transactions to smart accounts must **not** use a destination tag. A destination tag on the XRPL Payment lets a third party purchase the tag on the direct-minting facet and front-run the user.

Note that `IXRPPayment.ResponseBody` *does* expose `hasDestinationTag` and `destinationTag`, so the attestation carries them — you can and should assert `hasDestinationTag == false` rather than merely ignoring the field.

---

## 6. Prior art — the ground is not taken, but the niche is narrower than assumed

Searched GitHub (repository and code search), the Flare ecosystem, and Summer Signal / XRPL Commons submissions.

**No repository outside `flare-foundation` matches `MasterAccountController` or `handleMintedFAssets`.** Nobody is building a parallel rail.

Everything found **consumes** Flare's FSA rather than replacing it:

| Project | What it is | Language | Last push |
|---|---|---|---|
| [iaserveraims/Astryum-hackathon](https://github.com/iaserveraims/Astryum-hackathon) | Summer Signal + XRPL Commons. Non-custodial control plane; prepares unsigned txs, **uses FSA `0xFE`**; vault + FDC bridge + factory on Flare mainnet | TS/Solidity | 2026-09-20 |
| [Immadominion/flare-dart](https://github.com/Immadominion/flare-dart) | Pure-Dart SDK: FTSOv2, FDC, FAssets, **Smart Accounts** — the closest thing to an FSA SDK | Dart | 2026-08-12 |
| [Immadominion/plimsoll](https://github.com/Immadominion/plimsoll) | Decodes an XRPL payment's FSA/FAssets effect before signing; refuses ones that would fail | Dart | 2026-08-12 |
| [PhiBao/autopilot](https://github.com/PhiBao/autopilot) | Lifecycle manager for XRP savings on FSA | Solidity | 2026-08-02 |
| [holyaustin/PortalFX](https://github.com/holyaustin/PortalFX) | One-click XRP→yield on FSA v1.3 | TS | 2026-08-14 |
| [minhleeee123/xrp-payguard](https://github.com/minhleeee123/xrp-payguard) | Confidential XRP payment policies via FCC + FDC + FSA | TS | 2026-08-14 |
| [Tonyolumide/shadowroute](https://github.com/Tonyolumide/shadowroute) | Confidential FXRP intent routing via FDC + FSA + FCC | Go | 2026-08-13 |

All are hackathon-scale (0 stars, single-author, ~2-week lifespans). Official surfaces: FSA is live in **Xaman** as an xApp, and `flare-foundation/flare-ai-skills` ships a `flare-smart-accounts-skill`. No official TypeScript FSA SDK package was found.

**Honest read.** No one is building what you described. But the reason is not that the idea is unoccupied territory — it is that **Flare already shipped the arbitrary-call capability itself** (`0xFF`/`0xFE`, live on mainnet, in daily use). Your differentiation cannot be "arbitrary calls from an XRPL memo." It has to be the three things Flare's design genuinely does not offer:

1. **No provider-wallet allowlist.** Rail A requires payment to one XRPL address per chain, registered on the controller *(corrected 2026-09-23 from "Flare-operated", which the chain does not show)*. A permissionless rail lets anyone register a receiving address, or derives one per account.
2. **No FAssets coupling.** Rail B's arbitrary calls only exist as a side-effect of minting FXRP, and inherit direct-minting hourly/daily caps, a large-mint delay, and dependence on an agent with direct minting enabled. A rail built on `XRPPayment` attestations directly has none of that and can act on assets the account already holds.
3. **No governance pause or single global executor.** FSA is owner-controlled with a pause facet, a 1-hour timelock and one protocol executor. An open executor set with no pause is a materially different trust model.

That is a real and defensible gap. It is a narrower and more technical pitch than "Flare hardcodes three targets, we don't" — and the brief's framing should be updated before it goes to a grant committee, because a Flare reviewer will know about `0xFF`/`0xFE`.

---

## (a) Recommended network for v1

**Coston2.**

It is the only network with the complete stack: FDC, FDC V2, FTSOv2, FAssets/`AssetManagerFXRP`, a full FSA diamond (74 selectors, a strict superset of mainnet's 59), and FCC. Attestation fees are negligible (1000 wei vs 20 FLR), so iteration is effectively free. FXRP test liquidity is real (9.15M FTestXRP) and four funded ERC-4626 vaults are available as integration targets. It pairs with XRPL Testnet, which FDC attests.

Two qualifications, both material:

- **No lending market and no DEX exist on Coston2.** Plan the ERC-4626 reference integration on Coston2 and run the lending/DEX references against a **Flare mainnet fork** (Kinetic, Morpho and SparkDEX all have substantial real liquidity). Do not schedule a Coston2 lending demo; it cannot be built.
- **Do not use Coston** despite it also having FCC + FDC V2 — it has no FSA deployment to be compatible with, and its active TEE-machine set for extension 0 is empty.

Songbird is not a candidate: its FSA is an unregistered 3-transaction stub and `Payment`/`testXRP` is not even a supported attestation combination there.

## (b) Recommended memo layout

Two tiers. The strategic bet is Tier 2; Tier 1 exists so you work on day one and stay compatible with wallets that only know the 32-byte reference.

### Tier 1 — 32-byte payment reference, via FDC `Payment`

Claim instruction **type `0x3`** — the first free nibble, with 13 of 16 namespaces unused and no silent-misparse risk (Flare's dispatcher reverts `InvalidInstruction` on unknown combinations).

```
 byte:  0      1        2                                                     31
       +------+--------+-------------------------------------------------------+
       | 0x3C | wallet |   30-byte truncated keccak256 commitment to payload    |
       +------+--------+-------------------------------------------------------+
```

- Byte 0 `0x3C`: type `0x3` (your namespace), command `0xC` (commit). Preserves Flare's nibble semantics exactly, so existing encoders need only a new constant.
- Byte 1: wallet identifier, same position and meaning as Flare's.
- Bytes 2–31: **240-bit** truncated `keccak256` of the ABI-encoded call bundle. 120-bit birthday resistance — ample.

Put the executor fee **inside the committed payload**, not in the memo. The 32 bytes have no room for both a `uint64` fee and a strong commitment, and the executor receives the preimage off-chain before deciding to act, so it can read the fee there. This buys 8 bytes of commitment strength (176-bit → 240-bit) at no practical cost.

### Tier 2 — variable-length memo, via FDC `XRPPayment` (primary)

Reuse Flare's **exact 10-byte header** so a wallet that can build an FSA memo can build yours by changing one byte:

```
byte:  0        1                 2..9
       opcode   walletId (uint8)  executorFee (uint64, big-endian)
```

Claim two free opcodes adjacent to Flare's execute band:

| Opcode | Payload | Length | Mirrors |
|---|---|---|---|
| `0xFD` | `abi.encode(Call[])` inline | 10 + N (≤ ~1,019 total) | Flare's `0xFF` |
| `0xFC` | `bytes32 keccak256(payload)` | exactly **42** | Flare's `0xFE` |

`0xFC` is byte-for-byte the same shape as Flare's `0xFE` — same header, same 42-byte length, same hash-commitment semantics — differing only in the opcode. That is the minimum-change path for any wallet already integrated with FSA, which is the brief's stated goal.

Use `Call[] {address target; uint256 value; bytes data}` directly rather than `PackedUserOperation`. Flare honours only `sender`/`nonce`/`callData` and carries the other six fields purely for ABI compatibility; since you are not an ERC-4337 bundler, the dead weight costs memo bytes for nothing. Carry `sender` and `nonce` as explicit fields in your committed payload.

Also reserve `0xFB`–`0xF8` now for your own recovery opcodes. Flare's `0xE0`/`0xE1`/`0xE2` exist because XRPL payments are irreversible and a reverting instruction strands user funds — you will need the equivalent, and it is far cheaper to reserve the space before wallets integrate than after.

### Compatibility summary

| Channel | Flare uses | You take | Collision |
|---|---|---|---|
| 32-byte reference, type nibble | `0x0`,`0x1`,`0x2` | `0x3` | none — 12 nibbles still free |
| Memo opcode | `0xFF`,`0xFE`,`0xE2`,`0xE1`,`0xE0`,`0xD1`,`0xD0` | `0xFD`,`0xFC`, reserve `0xFB`–`0xF8` | none |
| Header shape | `[op][walletId][fee:u64]` | identical | n/a |

## (c) Ranked risk list

**1 — Differentiation, not feasibility, is the project risk.** Flare's `0xFF`/`0xFE` already does permissionless arbitrary calls and is live on mainnet with real usage. The brief's premise ("three hardcoded targets") is true only of Rail A. Any Flare-affiliated reviewer will know this. *Mitigation: rewrite the pitch around the three genuine gaps — no provider-wallet allowlist, no FAssets coupling, no governance pause — and lead with the `XRPPayment` attestation type, which is what makes an uncoupled rail possible.* **This is the risk most likely to sink the grant, and it is not technical.**

**2 — Coston2 has no lending market and no DEX.** Two of the three reference integrations in item 4 cannot be built on the recommended network at any liquidity level. *Mitigation: ERC-4626 on Coston2 against the four funded vaults; lending and DEX against a Flare mainnet fork. Decide this before scoping the demo, not during it.*

**3 — `XRPPayment` is undocumented surface.** It is the load-bearing element of the whole design and I found no developer-hub page for it. It exists in periphery v0.1.53 and is live on chain and in production use by FAssets, but the struct could change without a deprecation path, and there is no public spec to build against. *Mitigation: pin the periphery version; write an integration test that asserts the response-body shape; raise it with Flare early — their answer also tells you whether they intend to generalise the rail themselves, which feeds risk 1.*

**4 — Mainnet attestation economics.** 20 FLR per attestation request, and unconfirmed requests are **burnt**, not refunded. Every user instruction costs a request. At scale the fee model must cover this plus failure rate. Flare's own default instruction fee is 0.5 FXRP with 0.95 FXRP on the expensive paths — calibrate against that. *Mitigation: model unit economics before committing to a fee schedule; consider batching where the attestation type allows.*

**5 — Verifier API key and unmeasured rate limits.** The public key `00000000-0000-0000-0000-000000000000` works on testnet *and* mainnet today, but it is a shared Flare-operated value that can be revoked or throttled, and no published rate limits exist. *Mitigation: the verifier only prepares requests and MICs, both computable offline — keep it off the critical path from day one. Measure DA Layer limits in Phase 1 and plan to self-host both.*

**6 — The 32-byte `Payment` path is brittle.** It requires exactly one Memo of exactly 32 bytes. A wallet that adds `MemoType` or `MemoFormat` yields no `standardPaymentReference` at all, and the failure is silent from the user's perspective. *Mitigation: treat Tier 1 as a compatibility shim only; make Tier 2 the default; validate memo construction client-side before signing.*

**7 — Account fragmentation.** Your diamond is inside the CREATE2 initcode, so the same XRPL address derives a **different** account on your rail than on Flare's. No collision — but a user's funds split across two accounts they cannot distinguish. *Mitigation: surface both balances in any UI; consider a sweep instruction; be explicit in docs. Do not attempt to reuse Flare's account addresses — that would require their diamond as beacon and hand them control.*

**8 — Irreversible stranding.** XRPL payments cannot be reversed, and a reverting instruction leaves the user with a paid-for payment that can never execute. Flare needed three recovery opcodes (`0xE0`/`0xE1`/`0xE2`) plus a documented nonce-interaction matrix to handle this, and it is genuinely subtle — `0xE1` cannot rescue a UserOp whose nonce is at or below stored state. *Mitigation: design recovery before the happy path; reserve the opcodes now; port Flare's ordering discipline (check ignore-flag before any memo validation, so a malformed memo is still recoverable).*

**9 — Destination-tag front-running.** Flare explicitly forbids destination tags because a third party can buy the tag and front-run. *Mitigation: `XRPPayment` exposes `hasDestinationTag` — assert it is `false` on chain rather than ignoring the field.*

**10 — FAssets direct-minting caps, if you depend on them.** Hourly 4e12 / daily 4e13 UBA on mainnet, plus a large-mint delay above 4e12 and a 2-hour executor-exclusivity window. *Mitigation: the `XRPPayment`-direct design avoids all of this — which is precisely the argument for it.*

**11 — Positioning against Flare governance.** A permissionless rail over FAssets deliberately routes around FSA's pause facet and timelock. That is the point, but it may read to Flare as bypassing safety controls. *Mitigation: engage before building; consider a voluntary circuit-breaker that is credibly neutral, not a governance key.*

---

## Open items for Phase 1

- Quantify DA Layer rate limits empirically on Coston2 and mainnet.
- Obtain or reverse-engineer a public spec for `XRPPayment`; confirm with Flare whether it is stable.
- Confirm whether Flare intends to decouple Rail B from FAssets direct minting — this materially changes risk 1.
- Determine whether the FDC verifier is self-hostable from open source, or only the DA Layer is.
- Measure end-to-end latency: XRPL finality → attestation round → DA Layer availability → execution.

---

## One open question from the brief: the repo name

You asked me to name it. My suggestion: **`xrpl-instruction-rail`** — accurate, boring, and searchable, which matters when the differentiation argument (risk 1) is subtle and a reviewer is deciding in thirty seconds whether this is a clone of FSA.

If you want something with more identity, **`openmemo`** is my pick: it names the actual innovation (the memo channel is open, not the target list), it is short, and it does not over-claim. I would avoid anything containing "smart accounts" — it invites exactly the "isn't this just FSA?" reading you need to pre-empt.

Say the word and I will use it. Noted for when we start building: commits go directly to `main`, no PRs, your name only, no AI co-author or generated-with trailers.
