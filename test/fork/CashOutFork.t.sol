// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";
import {IXRPPaymentVerification} from "flare-periphery/coston2/IXRPPaymentVerification.sol";

import {ForkBase} from "./ForkBase.t.sol";
import {MemoCodec} from "../../contracts/libraries/MemoCodec.sol";
import {IPersonalAccount} from "../../contracts/interfaces/IPersonalAccount.sol";
import {IPostConditions} from "../../contracts/interfaces/IPostConditions.sol";

interface IFAssetsRedemption {
    function redeem(uint256 _lots, string memory _redeemerUnderlyingAddressString, address _executor)
        external
        payable
        returns (uint256);

    function lotSize() external view returns (uint256);

    function redemptionQueue(uint256 _first, uint256 _pageSize)
        external
        view
        returns (RedemptionTicket[] memory, uint256);

    struct RedemptionTicket {
        uint256 redemptionTicketId;
        address agentVault;
        uint256 ticketValueUBA;
    }

    event RedemptionRequested(
        address indexed agentVault,
        address indexed redeemer,
        uint256 indexed requestId,
        string paymentAddress,
        uint256 valueUBA,
        uint256 feeUBA,
        uint256 firstUnderlyingBlock,
        uint256 lastUnderlyingBlock,
        uint256 lastUnderlyingTimestamp,
        bytes32 paymentReference,
        address executor,
        uint256 executorFeeNatWei
    );
    event RedemptionRequestIncomplete(address indexed redeemer, uint256 remainingLots);
}

/**
 * @title CashOutForkTest
 * @notice The cash-out instruction against the real FAssets AssetManager on a Flare mainnet fork.
 *
 * @dev Why this is a fork test as well as a live one.
 *
 *      The cash-out DID run live on Coston2 -- see fixtures/measurements/cash-out-trace.json --
 *      but only on the second attempt. On the first, Coston2's FAssets redemption queue was
 *      empty: `redemptionQueue(0, 20)` returned zero tickets and a live `redeem(1)` reverted
 *      `RedeemZeroLots()`, after every one of memokit's own checks had passed. A day later the
 *      queue had refilled and the same instruction went through.
 *
 *      That is the reason this test exists. The testnet queue is inventory that other people
 *      supply and drain -- five tickets before the live trace, one after -- so a suite that
 *      depended on it would fail for reasons that have nothing to do with this code.
 *
 *      Flare mainnet has a real queue at the pinned block, with tickets in the hundreds of
 *      thousands of FXRP, so the instruction is exercised against the same contract it would
 *      meet in production. FDC verification is still simulated -- see the banner on ForkBase.
 */
contract CashOutForkTest is ForkBase {
    IFAssetsRedemption internal constant ASSET_MANAGER =
        IFAssetsRedemption(0x2a3Fe068cD92178554cabcf7c95ADf49B4B0B6A8);

    /// @dev The XRPL address the redeemed XRP is paid to: the payer's own, by default.
    string internal constant XRPL_DESTINATION = "rpnDcUjasCYome3WntkxqQ3gG4wuLXM4WE";

    /**
     * @dev Uses the `flare_archive` endpoint, at the same pinned block as every other fork
     *      test here.
     *
     *      Flare's own public RPC prunes state hard enough that forking it for anything the
     *      cache does not already hold fails with "missing trie node" -- at the shared pin,
     *      and still 50 blocks behind head. The other fork tests only survive because forge
     *      cached their reads earlier. This one touches the AssetManager's storage for the
     *      first time, so it needs an endpoint that actually serves history.
     */
    uint256 internal lotSize;

    function setUp() public override {
        vm.createSelectFork("flare_archive", FORK_BLOCK);
        _deployMemoKit(FORK_SOURCE_ID, RECEIVING);
        account = _accountFor(XRPL_SENDER);
        // SIMULATED VERIFICATION, same as ForkBase -- via the interface selector rather than
        // a hand-written signature string, which is how the first attempt got it wrong.
        vm.mockCall(
            FDC_VERIFICATION,
            abi.encodeWithSelector(IXRPPaymentVerification.verifyXRPPayment.selector),
            abi.encode(true)
        );
        emit log("SIMULATED FDC VERIFICATION: verifyXRPPayment mocked to true (see ForkBase)");
        lotSize = ASSET_MANAGER.lotSize();
    }

    function _redeemCalls(uint256 _lots) internal pure returns (IPersonalAccount.Call[] memory _c) {
        _c = new IPersonalAccount.Call[](1);
        _c[0] = IPersonalAccount.Call({
            target: address(ASSET_MANAGER),
            value: 0,
            data: abi.encodeCall(
                IFAssetsRedemption.redeem, (_lots, XRPL_DESTINATION, address(0))
            )
        });
    }

    function test_mainnetHasARedemptionQueueUnlikeCoston2() public view {
        (IFAssetsRedemption.RedemptionTicket[] memory queue,) = ASSET_MANAGER.redemptionQueue(0, 5);
        assertGt(queue.length, 0, "mainnet queue is populated");
        assertGt(queue[0].ticketValueUBA, lotSize, "the first ticket alone covers a lot");
    }

    /// @dev The instruction itself: one call, no approval, no native value, and the account
    ///      keeps whatever does not fill a lot.
    function test_cashOutRedeemsWholeLotsAndLeavesDust() public {
        uint256 dust = lotSize / 2;
        uint256 funded = lotSize + dust;
        _fundFxrp(account, funded);

        uint256 before = IERC20(FXRP).balanceOf(account);
        assertEq(before, funded);

        bytes memory payload = _instructionWithConditions(
            account,
            0,
            _redeemCalls(1),
            // A floor is all a post-condition can express here; the real claim is a spend.
            // See CASH_OUT_POST_CONDITION_NOTE in the SDK.
            _conditions(_pcErc20Balance(FXRP, account, dust))
        );

        vm.recordLogs();
        _deliver(payload);

        uint256 remaining = IERC20(FXRP).balanceOf(account);
        assertEq(remaining, dust, "exactly the dust is left; the lot was burned");
        assertEq(controller.nonceOf(account), 1);

        _assertRedemptionRequested();
    }

    function _assertRedemptionRequested() private {
        bytes32 wanted = keccak256(
            "RedemptionRequested(address,address,uint256,string,uint256,uint256,uint256,uint256,uint256,bytes32,address,uint256)"
        );
        bool found;
        string memory paymentAddress;
        uint256 valueUBA;

        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter != address(ASSET_MANAGER) || logs[i].topics[0] != wanted) continue;
            // redeemer is the second indexed field.
            assertEq(address(uint160(uint256(logs[i].topics[2]))), account, "redeemer is the account");
            // Nine non-indexed fields: paymentAddress, valueUBA, feeUBA, firstUnderlyingBlock,
            // lastUnderlyingBlock, lastUnderlyingTimestamp, paymentReference, executor,
            // executorFeeNatWei. Decoding fewer reverts, which is how the count got checked.
            (paymentAddress, valueUBA,,,,,,,) = abi.decode(
                logs[i].data,
                (string, uint256, uint256, uint256, uint256, uint256, bytes32, address, uint256)
            );
            found = true;
            break;
        }
        assertTrue(found, "RedemptionRequested was emitted");
        assertGt(valueUBA, 0, "a non-zero amount is owed on XRPL");
        emit log_named_string("agent must pay XRPL address", paymentAddress);
        emit log_named_uint("valueUBA owed", valueUBA);
    }

    /// @dev Below a lot there is nothing to redeem, and FAssets says so rather than rounding.
    function test_belowOneLotFAssetsRefuses() public {
        _fundFxrp(account, lotSize - 1);

        bytes memory payload = _instruction(account, 0, _redeemCalls(1));
        bytes32 txId = _nextTxId();

        vm.prank(executor);
        vm.expectRevert(); // RedeemZeroLots(), from FAssets
        controller.execute(
            _sdkProof(txId, _commitMemo(payload), block.timestamp - SIMULATED_LATENCY), payload
        );

        assertEq(IERC20(FXRP).balanceOf(account), lotSize - 1, "nothing moved");
        assertEq(controller.nonceOf(account), 0, "nonce unchanged");
        assertFalse(controller.isXrplTransactionConsumed(txId), "proof stays usable");
    }

    /// @dev Redeeming more lots than the account holds: FAssets reverts rather than partially
    ///      filling, so on this path the Phase 2 soft-failure problem does not arise.
    function test_askingForMoreLotsThanHeldReverts() public {
        _fundFxrp(account, lotSize);

        bytes memory payload = _instruction(account, 0, _redeemCalls(5));
        bytes32 txId = _nextTxId();

        vm.prank(executor);
        vm.expectRevert();
        controller.execute(
            _sdkProof(txId, _commitMemo(payload), block.timestamp - SIMULATED_LATENCY), payload
        );
        assertFalse(controller.isXrplTransactionConsumed(txId));
    }

    function test_multipleLotsInOneInstruction() public {
        _fundFxrp(account, lotSize * 3);

        bytes memory payload = _instructionWithConditions(
            account, 0, _redeemCalls(3), _conditions(_pcErc20Balance(FXRP, account, 0))
        );
        _deliver(payload);

        assertEq(IERC20(FXRP).balanceOf(account), 0, "all three lots redeemed");
    }
}
