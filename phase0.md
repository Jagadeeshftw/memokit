Task: investigation only. Write no code, create no contracts, open no PRs. Produce a written report.

We are scoping a new project: a permissionless, general-purpose version of Flare Smart Accounts. A user signs a single XRPL Payment transaction with instructions encoded in the memo; an operator proves that payment onto Flare via the Flare Data Connector; a per-XRPL-address proxy contract on Flare executes an arbitrary call. Flare's own FSA does this for three hardcoded targets (FXRP, Firelight, Upshift). We want an open adapter with no fixed target registry.

Investigate and report on the following, in order. Stop and flag immediately if item 1 comes back negative.

1. FDC permissionlessness (blocking).
Determine whether FDC Payment attestation requests can be made by any address. Specifically: who may call the FDC request contract; what the fee is and in which token; whether there is an allowlist, whitelist, or operator role; how the verifier and DA Layer are accessed and whether those endpoints are public or API-keyed; any rate limits. Check on both Coston2 and Flare mainnet. Cite contract addresses and the exact functions. If attestation requests are gated in any way, say so in the first line of your report.

2. Flare's FSA implementation.
Read github.com/flare-foundation/flare-smart-accounts. Report precisely:

The payment-reference / memo encoding scheme. The first nibble selects the target (0 = FXRP, 1 = Firelight, 2 = Upshift). Document the full byte layout, field widths, and how amounts and parameters are packed.
How MasterAccountController.executeTransaction validates the FDC proof and derives or creates the per-XRPL-address account.
The diamond structure, the executor and fee modules, pause and timelock.
Whether the memo format leaves any reserved or unused space we could extend into without collision.
Goal: we want to be wire-compatible with their memo format wherever possible, so wallets already integrated with FSA need minimal change to work with us.

3. Live network state.
Using the Flare Contract Registry on each of Coston, Coston2, Songbird and Flare mainnet, report which of these have a live, functional contract set: FDC (and FDC V2), FTSOv2, AssetManagerFXRP / FAssets, FSA MasterAccountController, FCC FlareTeeManager. Give addresses. For FCC specifically, call isTeeAvailable() and report the result. Note: published sources say Coston2 is the only network with a public FCC contract set, Songbird was approved by governance but has no published addresses, and Flare's docs call FCC not yet a fully public production system. Verify this rather than trusting it.

4. Target protocols for reference integrations.
On whichever network item 3 says is most complete, identify live, callable instances of: a lending market (check Kinetic, Mystic, Morpho deployments), a DEX with routable liquidity (check SparkDEX, OpenOcean), and an ERC-4626 vault. Report addresses and whether testnet instances actually hold usable liquidity. Testnet liquidity is the usual failure point here, so be concrete.

5. XRPL side.
Which XRPL network (Testnet or Devnet) pairs with the Flare network chosen in item 3, and does FDC attest payments on it. Report the XRPL memo field size limit and any encoding constraints, and whether Flare's own operator uses memos, destination tags, or both.

6. Prior art.
Search GitHub and the Flare ecosystem for anyone already building a generic or parallel FSA rail, an open instruction registry, or an FSA SDK. Include Summer Signal hackathon submissions. We need to know if this ground is taken.

Deliverable: a written report covering all six, ending with (a) a recommended network for v1, (b) a recommended memo layout that stays compatible with Flare's scheme while supporting arbitrary calls, and (c) a ranked risk list. No code.

Commit rules when we do start building: commit directly to main, no pull requests. Commits carry my name only, with no AI co-author trailer or generated-with attribution.

One small thing I left open: what do you want to call the repo? I'll hold the name out of the brief until you say.