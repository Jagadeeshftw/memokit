// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MemoKitTestBase} from "./base/MemoKitTestBase.sol";
import {MemoCodec} from "../contracts/libraries/MemoCodec.sol";
import {IPersonalAccount} from "../contracts/interfaces/IPersonalAccount.sol";
import {RevertBomb} from "../contracts/mocks/RevertBomb.sol";

/**
 * @title ExecutorEconomicsTest
 * @notice What an executor is exposed to, measured. The narrative is in PHASE2.md; these are the
 *         numbers and the properties it rests on.
 *
 * @dev The one loss an executor cannot avoid by reading the payload is the gas of a transaction
 *      that reverts. A revert unwinds everything, including the fee, so a failing instruction
 *      costs the executor gas and pays nothing. Run with `-vv` to see the figures.
 */
contract ExecutorEconomicsTest is MemoKitTestBase {
    bytes32 internal constant TX_ID = bytes32(uint256(0xe1));
    address internal account;
    address internal recipient;
    RevertBomb internal bomb;

    function setUp() public override {
        super.setUp();
        account = _accountFor(XRPL_SENDER);
        recipient = makeAddr("recipient");
        bomb = new RevertBomb();
        _fund(account, 100_000_000);
    }

    function _commit(bytes memory _payload) internal pure returns (bytes memory) {
        return abi.encodePacked(_header(MemoCodec.OP_EXEC_COMMIT, 1, uint64(0)), keccak256(_payload));
    }

    function _transferPayload(uint256 _fee) internal view returns (bytes memory) {
        return _instructionWithFee(
            account,
            0,
            address(fxrp),
            _fee,
            _oneCall(address(fxrp), 0, abi.encodeCall(IERC20.transfer, (recipient, 1_000)))
        );
    }

    function _bombPayload(uint256 _bytes) internal view returns (bytes memory) {
        return _instructionWithFee(
            account, 0, address(fxrp), 200_000, _oneCall(address(bomb), 0, abi.encodeCall(RevertBomb.boom, (_bytes)))
        );
    }

    /// @dev Gas the caller pays for `execute`, measured around the call. `_expectSuccess` says
    ///      which way it must go so a measurement can never silently record the wrong branch.
    function _gasOfExecute(bytes memory _payload, bool _expectSuccess) internal returns (uint256 _gas) {
        vm.prank(executor);
        uint256 before = gasleft();
        try controller.execute(_proof(TX_ID, _commit(_payload)), _payload) {
            _gas = before - gasleft();
            assertTrue(_expectSuccess, "expected a revert");
        } catch {
            _gas = before - gasleft();
            assertFalse(_expectSuccess, "expected success");
        }
    }

    // --- what a revert costs the executor ------------------------------------------------

    /// @dev A failing instruction costs the executor its gas and pays it nothing: the fee is
    ///      unwound with everything else. Measured against a mock FDC verifier, which is far cheaper
    ///      than the real Merkle check, so these are floors.
    function test_aRevertedInstructionCostsGasAndPaysNothing() public {
        uint256 ok = _gasOfExecute(_transferPayload(200_000), true);
        assertEq(fxrp.balanceOf(executor), 200_000, "paid on success");

        // A fresh account for the failing run so both include first-use account deployment.
        address failing = _accountFor("rFailingAccountXXXXXXXXXXXXXXXXXX");
        _fund(failing, 100_000_000);
        bytes memory payload = _instructionWithFee(
            failing, 0, address(fxrp), 200_000, _oneCall(address(bomb), 0, abi.encodeCall(RevertBomb.boom, (0)))
        );
        vm.prank(executor);
        uint256 before = gasleft();
        try controller.execute(
            _proofWith(bytes32(uint256(0xe2)), _commit(payload), _overridesFor("rFailingAccountXXXXXXXXXXXXXXXXXX")), payload
        ) {
            fail("must revert");
        } catch {}
        uint256 reverted = before - gasleft();

        emit log_named_uint("gas: successful execute (single transfer + fee)", ok);
        emit log_named_uint("gas: reverted execute (one failing call)", reverted);
        assertEq(fxrp.balanceOf(executor), 200_000, "no second payment");
        assertEq(controller.nonceOf(failing), 0);
    }

    function _overridesFor(string memory _sender) internal view returns (ProofOverrides memory o) {
        o = _defaults();
        o.sourceAddress = _sender;
    }

    /// @dev The instruction is not burnt by a failed attempt. Whatever made it fail can change, and
    ///      the same proof works then -- which is the difference between "an executor lost gas" and
    ///      "the user lost the instruction".
    function test_aFailedInstructionIsRetriableOnceItsCauseClears() public {
        // Fee larger than the balance: fails.
        bytes memory payload = _transferPayload(1_000_000_000);
        _gasOfExecute(payload, false);
        assertFalse(controller.isXrplTransactionConsumed(TX_ID), "not consumed");
        assertEq(controller.nonceOf(account), 0, "nonce not advanced");

        // Someone tops the account up; the very same proof and preimage now succeed.
        fxrp.mint(account, 2_000_000_000);
        _gasOfExecute(payload, true);
        assertEq(fxrp.balanceOf(executor), 1_000_000_000, "paid once, on the attempt that worked");
        assertEq(controller.nonceOf(account), 1);
    }

    // --- what an owner can do to an executor ---------------------------------------------

    /// @dev The residual risk, demonstrated. An executor simulates, sees success, sends; before it
    ///      lands, the owner's own competing instruction removes what the first needed. The
    ///      executor's transaction reverts and it pays for the attempt. The owner has spent an XRPL
    ///      payment and an attestation; the executor has spent gas.
    function test_anOwnerCanMakeASimulatedSuccessRevertOnChain() public {
        bytes memory payload = _transferPayload(200_000);

        // The executor's dry run. It passes.
        uint256 snap = vm.snapshotState();
        _gasOfExecute(payload, true);
        vm.revertToState(snap);

        // The owner moves the funds out first, by its own instruction, self-executed.
        address self = makeAddr("owner-self-executing");
        bytes memory drain = _instruction(
            account, 0, _oneCall(address(fxrp), 0, abi.encodeCall(IERC20.transfer, (self, 100_000_000)))
        );
        vm.prank(self);
        controller.execute(_proof(bytes32(uint256(0xd1)), _commit(drain)), drain);

        // The executor's real transaction: nonce 0 is now spent, so it reverts.
        uint256 lost = _gasOfExecute(payload, false);
        emit log_named_uint("gas an executor loses to one such attempt", lost);
        assertEq(fxrp.balanceOf(executor), 0, "and earns nothing");
    }

    /// @dev The owner cannot make the executor pay MORE than its own gas limit: a call that burns
    ///      everything it is given ends the transaction, and the executor sets that limit.
    function test_theExecutorsLossIsBoundedByItsOwnGasLimit() public {
        bytes memory payload = _bombPayload(0);
        vm.prank(executor);
        (bool ok,) = address(diamond).call{gas: 300_000}(
            abi.encodeCall(controller.execute, (_proof(TX_ID, _commit(payload)), payload))
        );
        assertFalse(ok, "reverted inside the executor's own limit");
    }

    /// @dev A target that reverts with a big blob makes the failing transaction dearer -- but most
    ///      of that is the *target* paying to build the blob (memory expansion is quadratic), which
    ///      it would pay called directly and which the owner could equally spend in a loop. What the
    ///      account must not do is add a second, size-proportional cost of its own by copying and
    ///      re-encoding the data. So the check is on the account's overhead: gas of the whole
    ///      failing `execute` minus gas of the same call made bare. Before the bounded copy this
    ///      overhead grew from ~0.3M to ~1.5M as the blob grew from 32 B to 300 KB.
    function test_theAccountAddsNoSizeProportionalCostToARevert() public {
        uint256 overheadSmall = _overhead(32);
        uint256 overheadMedium = _overhead(10_000);
        uint256 overheadLarge = _overhead(300_000);
        emit log_named_uint("account overhead, 32 B revert", overheadSmall);
        emit log_named_uint("account overhead, 10 KB revert", overheadMedium);
        emit log_named_uint("account overhead, 300 KB revert", overheadLarge);
        assertLt(overheadLarge, overheadSmall + 10_000, "overhead must not scale with the blob");
    }

    function _overhead(uint256 _bytes) internal returns (uint256) {
        uint256 bare = gasleft();
        try bomb.boom(_bytes) {} catch {}
        bare -= gasleft();
        return _revertGas(_bytes) - bare;
    }

    /// @dev Bounding must not blind the owner: a real revert reason survives intact, and one over
    ///      the cap is cut to it rather than dropped.
    function test_revertReasonsAreKeptUpToTheCapAndTruncatedBeyondIt() public {
        assertEq(_revertBytesOf(200).length, 200, "under the cap: intact");
        assertEq(_revertBytesOf(5_000).length, 256, "over the cap: cut to it");
    }

    function _revertBytesOf(uint256 _n) internal returns (bytes memory _reason) {
        bytes memory payload = _bombPayload(_n);
        vm.prank(executor);
        try controller.execute(_proof(TX_ID, _commit(payload)), payload) {
            fail("must revert");
        } catch (bytes memory err) {
            // CallFailed(uint256 index, bytes reason)
            (, _reason) = abi.decode(_slice(err, 4), (uint256, bytes));
        }
    }

    function _slice(bytes memory _b, uint256 _from) internal pure returns (bytes memory _out) {
        _out = new bytes(_b.length - _from);
        for (uint256 i = 0; i < _out.length; ++i) {
            _out[i] = _b[_from + i];
        }
    }

    /// @dev The same lever on the success path: a call returning a big blob it need not have must
    ///      not cost the caller a copy of it. The callee still pays to build the blob, so the
    ///      account's share is what is compared, as above.
    function test_aLargeReturnValueOnASuccessfulCallIsNotCopied() public {
        uint256 small = _successGas(32);
        uint256 large = _successGas(300_000);
        uint256 bareSmall = _bareBloat(32);
        uint256 bareLarge = _bareBloat(300_000);
        // Signed only so a surprise shows as a number rather than a panic.
        int256 overheadSmall = int256(small) - int256(bareSmall);
        int256 overheadLarge = int256(large) - int256(bareLarge);
        emit log_named_int("account overhead, success returning 32 B", overheadSmall);
        emit log_named_int("account overhead, success returning 300 KB", overheadLarge);
        assertLt(overheadLarge, overheadSmall + 10_000, "no copy of the return value");
    }

    /// @dev The callee's own cost, with no copy of what it returns on the caller's side.
    function _bareBloat(uint256 _bytes) internal returns (uint256 _g) {
        bytes memory data = abi.encodeCall(RevertBomb.bloat, (_bytes));
        address target = address(bomb);
        _g = gasleft();
        // solhint-disable-next-line no-inline-assembly
        assembly ("memory-safe") {
            pop(call(gas(), target, 0, add(data, 0x20), mload(data), 0, 0))
        }
        _g -= gasleft();
    }

    function _successGas(uint256 _bytes) internal returns (uint256 _gas) {
        uint256 snap = vm.snapshotState();
        bytes memory payload = _instructionWithFee(
            account, 0, address(fxrp), 0, _oneCall(address(bomb), 0, abi.encodeCall(RevertBomb.bloat, (_bytes)))
        );
        _gas = _gasOfExecute(payload, true);
        vm.revertToState(snap);
    }

    function _revertGas(uint256 _bytes) internal returns (uint256 _gas) {
        uint256 snap = vm.snapshotState();
        bytes memory payload = _bombPayload(_bytes);
        _gas = _gasOfExecute(payload, false);
        vm.revertToState(snap);
    }

    // --- what an executor can and cannot alter -------------------------------------------

    /// @dev `msg.value` is the executor's own money and is forwarded to the account. It can only
    ///      add to the account's native balance; no call in the payload changes because of it.
    function test_executorValueOnlyDonatesToTheAccount() public {
        bytes memory payload = _transferPayload(200_000);
        vm.deal(executor, 1 ether);
        vm.prank(executor);
        controller.execute{value: 0.5 ether}(_proof(TX_ID, _commit(payload)), payload);

        assertEq(account.balance, 0.5 ether, "donated");
        assertEq(fxrp.balanceOf(recipient), 1_000, "the payload ran exactly as committed");
        assertEq(executor.balance, 0.5 ether, "and it cannot be taken back out");
    }

    /// @dev Whoever lands `execute` first is paid. There is no reservation, so a searcher who copies
    ///      an executor's transaction takes the fee, but cannot alter the payload it carries.
    function test_theFirstValidExecuteIsPaidAndTheSecondReverts() public {
        bytes memory payload = _transferPayload(200_000);
        address copycat = makeAddr("copycat");

        vm.prank(copycat);
        controller.execute(_proof(TX_ID, _commit(payload)), payload);

        vm.prank(executor);
        vm.expectRevert();
        controller.execute(_proof(TX_ID, _commit(payload)), payload);

        assertEq(fxrp.balanceOf(copycat), 200_000);
        assertEq(fxrp.balanceOf(executor), 0);
    }
}
