// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ForkBase} from "./ForkBase.t.sol";
import {IPersonalAccount} from "../../contracts/interfaces/IPersonalAccount.sol";

/**
 * @title PayoutForkTest
 * @notice How a payout scales, measured with REAL FXRP on a mainnet fork (verification simulated;
 *         see `ForkBase`). Backs the decision in PHASE2.md to use a plain `Call[]` of transfers
 *         rather than a helper contract: the memo is 42 bytes whatever N is, and the per-recipient
 *         cost is one ERC-20 transfer, which a helper would still have to make.
 */
contract PayoutForkTest is ForkBase {
    uint256 internal constant EACH = 1e6; // 1 FXRP per recipient
    uint256 internal constant FEE = 100_000;

    function _payout(uint256 _n) internal returns (uint256 gasUsed, uint256 payloadBytes, uint256 memoBytes) {
        address[] memory to = new address[](_n);
        IPersonalAccount.Call[] memory calls = new IPersonalAccount.Call[](_n);
        for (uint256 i = 0; i < _n; ++i) {
            to[i] = address(uint160(0xC0FFEE00 + i));
            calls[i] = _call(FXRP, abi.encodeCall(IERC20.transfer, (to[i], EACH)));
        }
        _fundFxrp(account, _n * EACH + FEE);

        bytes memory payload = _instructionWithFee(account, controller.nonceOf(account), FXRP, FEE, calls);
        payloadBytes = payload.length;
        memoBytes = _commitMemo(payload).length;

        uint256 before = gasleft();
        _deliver(payload);
        gasUsed = before - gasleft();

        for (uint256 i = 0; i < _n; ++i) {
            assertEq(IERC20(FXRP).balanceOf(to[i]), EACH, "every recipient paid");
        }
        assertEq(IERC20(FXRP).balanceOf(account), 0, "drained exactly");
        assertEq(IERC20(FXRP).balanceOf(executor), FEE);
    }

    function test_payoutScalesLinearlyAndTheMemoStaysFortyTwoBytes() public {
        uint256[4] memory ns = [uint256(1), 5, 20, 100];
        uint256[4] memory gasAt;
        for (uint256 k = 0; k < ns.length; ++k) {
            uint256 snap = vm.snapshotState();
            (uint256 g, uint256 payloadBytes, uint256 memoBytes) = _payout(ns[k]);
            gasAt[k] = g;
            emit log_named_uint(string.concat("N=", vm.toString(ns[k]), " gas"), g);
            emit log_named_uint(string.concat("N=", vm.toString(ns[k]), " payload bytes (off-chain, hashed)"), payloadBytes);
            assertEq(memoBytes, 42, "the XRPL memo does not grow with N");
            vm.revertToState(snap);
        }
        uint256 perRecipient = (gasAt[3] - gasAt[1]) / (ns[3] - ns[1]);
        emit log_named_uint("marginal gas per recipient (N=5 -> N=100)", perRecipient);
        assertLt(perRecipient, 100_000, "one transfer plus call overhead per recipient, nothing superlinear");
    }
}
