// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IXRPPaymentVerification} from "flare-periphery/coston2/IXRPPaymentVerification.sol";
import {IXRPPayment} from "flare-periphery/coston2/IXRPPayment.sol";

import {MemoKitTestBase} from "../base/MemoKitTestBase.sol";
import {MemoCodec} from "../../contracts/libraries/MemoCodec.sol";
import {IPersonalAccount} from "../../contracts/interfaces/IPersonalAccount.sol";

/**
 * @title ForkBase
 * @notice memokit deployed on a fork of Flare MAINNET, next to the real lending market and DEX.
 *
 * ==========================  SIMULATED VERIFICATION  ==========================
 * `FdcVerification.verifyXRPPayment` is MOCKED to return true. Nothing in these tests was attested
 * by FDC, and no XRPL transaction was sent: mainnet spends real XRP and Phase 2 is out of scope for
 * a live mainnet run. The proofs are built by Phase 1's `buildXrpPaymentResponse` (via
 * `sdk/scripts/forkProof.ts`) from a representative ledger record, so every field the contract
 * reads other than the Merkle check comes from production code. The REAL attested path -- XRPL
 * Payment, requestAttestation, DA-Layer proof, execute -- is Phase 1's Coston2 trace and Phase 2's
 * payout trace under fixtures/measurements/. What these tests prove is what memokit does with the
 * calls once an attestation exists, against the real contracts those calls target.
 * ==============================================================================
 *
 * Run: `npm run test:fork` (FOUNDRY_PROFILE=fork forge). Needs network access the first time; forge
 * caches what it fetches, keyed by the pinned block.
 */
abstract contract ForkBase is MemoKitTestBase {
    /// @dev Pinned so results are reproducible; Flare mainnet, ~2026-09-21.
    uint256 internal constant FORK_BLOCK = 70_267_728;

    address internal constant FDC_VERIFICATION = 0x5C14FE9D73Ab763F4d4a76f334bf7029DDD20Ecc;
    address internal constant FXRP = 0xAd552A648C74D49E10027AB8a618A3ad4901c5bE;
    bytes32 internal constant FORK_SOURCE_ID = bytes32("XRP");

    /// @dev Seconds between the simulated XRPL close time and the fork block: the 152-162 s Phase 1
    ///      measured, rounded, so a proof looks as old as a real one does when it is submitted.
    uint256 internal constant SIMULATED_LATENCY = 150;

    /// @dev A real FXRP holder to draw test balances from: the Firelight stXRP vault (~51.6M FXRP at
    ///      the pinned block). Not `deal`: FXRP is a Flare FAsset with checkpointed balances, and a
    ///      raw storage write makes `balanceOf` report a balance that `transfer` cannot spend (it
    ///      panics with an arithmetic underflow). Impersonating a holder moves real FXRP instead.
    address internal constant FXRP_HOLDER = 0x4C18Ff3C89632c3Dd62E796c0aFA5c07c4c1B2b3;

    address internal account;
    uint256 private _txCounter;

    function setUp() public virtual override {
        vm.createSelectFork("flare", FORK_BLOCK);
        _deployMemoKit(FORK_SOURCE_ID, RECEIVING);
        account = _accountFor(XRPL_SENDER);

        // SIMULATED VERIFICATION: see the banner above.
        vm.mockCall(
            FDC_VERIFICATION, abi.encodeWithSelector(IXRPPaymentVerification.verifyXRPPayment.selector), abi.encode(true)
        );
        emit log("SIMULATED FDC VERIFICATION: verifyXRPPayment mocked to true (see ForkBase)");
    }

    function _fundFxrp(address _to, uint256 _amount) internal {
        vm.prank(FXRP_HOLDER);
        (bool ok,) = FXRP.call(abi.encodeWithSignature("transfer(address,uint256)", _to, _amount));
        require(ok, "funding from the FXRP holder failed");
    }

    // --- proofs -------------------------------------------------------------------------

    /// @dev A proof for `_memo`, built by the SDK. `_closeTime` is the simulated XRPL close time.
    function _sdkProof(bytes32 _txId, bytes memory _memo, uint256 _closeTime)
        internal
        returns (IXRPPayment.Proof memory)
    {
        string[] memory cmd = new string[](8);
        cmd[0] = "node_modules/.bin/tsx";
        cmd[1] = "sdk/scripts/forkProof.ts";
        cmd[2] = XRPL_SENDER;
        cmd[3] = RECEIVING;
        cmd[4] = vm.toString(_memo);
        cmd[5] = vm.toString(_txId);
        cmd[6] = vm.toString(_closeTime);
        cmd[7] = "XRP";
        return abi.decode(vm.ffi(cmd), (IXRPPayment.Proof));
    }

    function _nextTxId() internal returns (bytes32) {
        return keccak256(abi.encode("memokit-fork-tx", ++_txCounter));
    }

    function _commitMemo(bytes memory _payload) internal pure returns (bytes memory) {
        return abi.encodePacked(_header(MemoCodec.OP_EXEC_COMMIT, 1, uint64(0)), keccak256(_payload));
    }

    /// @dev Delivers `_payload` as the executor and returns the XRPL transaction id used.
    function _deliver(bytes memory _payload) internal returns (bytes32 txId) {
        txId = _nextTxId();
        IXRPPayment.Proof memory proof = _sdkProof(txId, _commitMemo(_payload), block.timestamp - SIMULATED_LATENCY);
        vm.prank(executor);
        controller.execute(proof, _payload);
    }

    /// @dev Builds the proof for `_payload` without delivering it, so a test can submit the very same
    ///      proof again later (a retry, or after a recovery memo).
    function _prepare(bytes memory _payload) internal returns (bytes32 txId, IXRPPayment.Proof memory proof) {
        txId = _nextTxId();
        proof = _sdkProof(txId, _commitMemo(_payload), block.timestamp - SIMULATED_LATENCY);
    }

    /// @dev Submits, as the executor, expecting a revert; returns why the account says it failed.
    function _failureOf(IXRPPayment.Proof memory _proof, bytes memory _payload)
        internal
        returns (uint256 callIndex, bytes memory reason)
    {
        vm.prank(executor);
        try controller.execute(_proof, _payload) {
            fail("expected the instruction to revert");
        } catch (bytes memory err) {
            require(bytes4(err) == IPersonalAccount.CallFailed.selector, "not a CallFailed revert");
            bytes memory body = new bytes(err.length - 4);
            for (uint256 i = 0; i < body.length; ++i) {
                body[i] = err[i + 4];
            }
            (callIndex, reason) = abi.decode(body, (uint256, bytes));
        }
    }

    /// @dev As `_deliver`, but for a recovery memo, which carries no payload.
    function _deliverMemo(bytes memory _memo) internal returns (bytes32 txId) {
        txId = _nextTxId();
        IXRPPayment.Proof memory proof = _sdkProof(txId, _memo, block.timestamp - SIMULATED_LATENCY);
        vm.prank(executor);
        controller.execute(proof, "");
    }

    function _call(address _target, bytes memory _data) internal pure returns (IPersonalAccount.Call memory) {
        return IPersonalAccount.Call({target: _target, value: 0, data: _data});
    }
}
