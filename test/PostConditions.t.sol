// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MemoKitTestBase} from "./base/MemoKitTestBase.sol";
import {MemoCodec} from "../contracts/libraries/MemoCodec.sol";
import {PostConditions} from "../contracts/libraries/PostConditions.sol";
import {IPostConditions} from "../contracts/interfaces/IPostConditions.sol";
import {IPersonalAccount} from "../contracts/interfaces/IPersonalAccount.sol";
import {Execution} from "../contracts/libraries/Execution.sol";
import {MockERC20} from "../contracts/mocks/MockERC20.sol";

/// @notice A target that takes the tokens and reports success without doing the thing.
/// @dev Stands in for the Compound-family behaviour Phase 2 found: an oversized borrow returns
///      error code 3 instead of reverting, so the call "succeeds" and nothing happens.
contract SoftFailingMarket {
    IERC20 public immutable collateral;
    IERC20 public immutable borrowToken;
    bool public payOut = true;

    constructor(IERC20 _collateral, IERC20 _borrowToken) {
        collateral = _collateral;
        borrowToken = _borrowToken;
    }

    function setPayOut(bool _v) external {
        payOut = _v;
    }

    function deposit(uint256 _amount) external returns (uint256) {
        collateral.transferFrom(msg.sender, address(this), _amount);
        return 0;
    }

    /// @return 0 on success, 3 on refusal -- and never a revert, which is the whole problem.
    function borrow(uint256 _amount) external returns (uint256) {
        if (!payOut) {
            return 3;
        }
        borrowToken.transfer(msg.sender, _amount);
        return 0;
    }
}

/// @notice Accepts native value so a native-delta condition has something to measure.
contract NativeSink {
    receive() external payable {}

    function forward(address payable _to) external payable {
        (bool ok,) = _to.call{value: msg.value}("");
        require(ok, "forward failed");
    }
}

/**
 * @title PostConditionsTest
 * @notice The balance and delta post-conditions, and the failure they exist to catch.
 */
contract PostConditionsTest is MemoKitTestBase {
    bytes32 internal constant TX_ID = bytes32(uint256(0xbc));

    address internal account;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    MockERC20 internal usd;
    SoftFailingMarket internal market;

    function setUp() public override {
        super.setUp();
        account = _accountFor(XRPL_SENDER);
        usd = new MockERC20("Test USD", "tUSD", 6);
        market = new SoftFailingMarket(fxrp, usd);
        _fund(account, 100_000_000);
        usd.mint(address(market), 1_000_000_000);
    }

    function _commit(bytes memory _payload) internal pure returns (bytes memory) {
        return abi.encodePacked(_header(MemoCodec.OP_EXEC_COMMIT, 1, uint64(0)), keccak256(_payload));
    }

    function _run(bytes memory _payload) internal {
        vm.prank(executor);
        controller.execute(_proof(TX_ID, _commit(_payload)), _payload);
    }

    function _transfer(address _to, uint256 _amount)
        internal
        view
        returns (IPersonalAccount.Call[] memory)
    {
        return _oneCall(address(fxrp), 0, abi.encodeCall(IERC20.transfer, (_to, _amount)));
    }

    // --- the kinds ----------------------------------------------------------------------

    function test_erc20BalanceAtLeastPasses() public {
        bytes memory payload = _instructionWithConditions(
            account, 0, _transfer(alice, 10_000), _conditions(_pcErc20Balance(address(fxrp), alice, 10_000))
        );
        _run(payload);
        assertEq(fxrp.balanceOf(alice), 10_000);
    }

    function test_erc20BalanceAtLeastFailsAndUnwinds() public {
        bytes memory payload = _instructionWithConditions(
            account, 0, _transfer(alice, 10_000), _conditions(_pcErc20Balance(address(fxrp), alice, 10_001))
        );
        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPostConditions.PostConditionFailed.selector,
                0,
                IPostConditions.Kind.Erc20BalanceAtLeast,
                10_001,
                10_000
            )
        );
        controller.execute(_proof(TX_ID, _commit(payload)), payload);

        assertEq(fxrp.balanceOf(alice), 0, "transfer unwound");
        assertEq(controller.nonceOf(account), 0, "nonce unwound");
        assertFalse(controller.isXrplTransactionConsumed(TX_ID), "replay mark unwound");
    }

    /// @dev Deltas must work for arbitrary addresses, so a payout can assert each recipient
    ///      was paid rather than only that the account ended up empty.
    function test_erc20DeltaOnAThirdPartyRecipient() public {
        deal(address(fxrp), alice, 5_000); // a pre-existing balance the delta must ignore

        IPersonalAccount.Call[] memory calls = new IPersonalAccount.Call[](2);
        calls[0] = IPersonalAccount.Call(
            address(fxrp), 0, abi.encodeCall(IERC20.transfer, (alice, 1_000))
        );
        calls[1] = IPersonalAccount.Call(
            address(fxrp), 0, abi.encodeCall(IERC20.transfer, (bob, 2_000))
        );

        bytes memory payload = _instructionWithConditions(
            account,
            0,
            calls,
            _conditions(
                _pcErc20Delta(address(fxrp), alice, 1_000), _pcErc20Delta(address(fxrp), bob, 2_000)
            )
        );
        _run(payload);

        assertEq(fxrp.balanceOf(alice), 6_000, "pre-existing balance untouched");
        assertEq(fxrp.balanceOf(bob), 2_000);
    }

    function test_erc20DeltaFailsWhenARecipientIsShort() public {
        IPersonalAccount.Call[] memory calls = _transfer(alice, 999);
        bytes memory payload = _instructionWithConditions(
            account, 0, calls, _conditions(_pcErc20Delta(address(fxrp), alice, 1_000))
        );
        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPostConditions.PostConditionFailed.selector,
                0,
                IPostConditions.Kind.Erc20DeltaAtLeast,
                1_000,
                999
            )
        );
        controller.execute(_proof(TX_ID, _commit(payload)), payload);
    }

    /// @dev A balance that fell reports a delta of zero, not an arithmetic panic.
    function test_aFallingBalanceReportsZeroDeltaRatherThanPanicking() public {
        deal(address(fxrp), alice, 5_000);
        vm.prank(alice);
        fxrp.transfer(bob, 5_000); // not part of the instruction; alice just ends lower

        IPersonalAccount.Call[] memory calls = _transfer(bob, 1);
        bytes memory payload = _instructionWithConditions(
            account, 0, calls, _conditions(_pcErc20Delta(address(fxrp), alice, 1))
        );
        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPostConditions.PostConditionFailed.selector,
                0,
                IPostConditions.Kind.Erc20DeltaAtLeast,
                1,
                0
            )
        );
        controller.execute(_proof(TX_ID, _commit(payload)), payload);
    }

    function test_nativeBalanceAndDelta() public {
        NativeSink sink = new NativeSink();
        vm.deal(address(account), 1 ether);

        IPersonalAccount.Call[] memory calls = _oneCall(address(sink), 0.4 ether, "");
        bytes memory payload = _instructionWithConditions(
            account,
            0,
            calls,
            _conditions(
                _pcNativeDelta(address(sink), 0.4 ether), _pcNativeBalance(address(account), 0.6 ether)
            )
        );
        _run(payload);

        assertEq(address(sink).balance, 0.4 ether);
        assertEq(address(account).balance, 0.6 ether);
    }

    function test_nativeDeltaFails() public {
        NativeSink sink = new NativeSink();
        vm.deal(address(account), 1 ether);

        IPersonalAccount.Call[] memory calls = _oneCall(address(sink), 0.1 ether, "");
        bytes memory payload = _instructionWithConditions(
            account, 0, calls, _conditions(_pcNativeDelta(address(sink), 0.2 ether))
        );
        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPostConditions.PostConditionFailed.selector,
                0,
                IPostConditions.Kind.NativeDeltaAtLeast,
                0.2 ether,
                0.1 ether
            )
        );
        controller.execute(_proof(TX_ID, _commit(payload)), payload);
    }

    // --- the soft-failure this exists for -------------------------------------------------

    /// @dev Phase 2's finding, reproduced in miniature: the borrow is refused by return code,
    ///      the call reports success, and without an assertion the instruction is consumed.
    function test_withoutAPostConditionASoftFailureIsConsumedAsSuccess() public {
        market.setPayOut(false);

        bytes memory payload = _instruction(account, 0, _depositAndBorrow(50_000_000, 1_000_000));
        _run(payload);

        assertEq(usd.balanceOf(account), 0, "nothing borrowed");
        assertEq(controller.nonceOf(account), 1, "but the nonce advanced");
        assertTrue(controller.isXrplTransactionConsumed(TX_ID), "and the payment is spent");
    }

    /// @dev The same failure with a post-condition: everything unwinds and the proof is reusable.
    function test_withAPostConditionTheSameSoftFailureUnwindsEverything() public {
        market.setPayOut(false);

        bytes memory payload = _instructionWithConditions(
            account,
            0,
            _depositAndBorrow(50_000_000, 1_000_000),
            _conditions(_pcErc20DeltaFor(address(usd), account, 1_000_000))
        );

        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPostConditions.PostConditionFailed.selector,
                0,
                IPostConditions.Kind.Erc20DeltaAtLeast,
                1_000_000,
                0
            )
        );
        controller.execute(_proof(TX_ID, _commit(payload)), payload);

        assertEq(fxrp.balanceOf(account), 100_000_000, "collateral not deposited");
        assertEq(controller.nonceOf(account), 0, "nonce unchanged");
        assertFalse(controller.isXrplTransactionConsumed(TX_ID), "proof reusable");
    }

    function test_theSameInstructionSucceedsWhenTheMarketPaysOut() public {
        bytes memory payload = _instructionWithConditions(
            account,
            0,
            _depositAndBorrow(50_000_000, 1_000_000),
            _conditions(_pcErc20DeltaFor(address(usd), account, 1_000_000))
        );
        _run(payload);
        assertEq(usd.balanceOf(account), 1_000_000);
        assertEq(controller.nonceOf(account), 1);
    }

    function _pcErc20DeltaFor(address _token, address _subject, uint256 _atLeast)
        private
        pure
        returns (IPostConditions.PostCondition memory)
    {
        return _pcErc20Delta(_token, _subject, _atLeast);
    }

    function _depositAndBorrow(uint256 _collateral, uint256 _borrow)
        private
        view
        returns (IPersonalAccount.Call[] memory _calls)
    {
        _calls = new IPersonalAccount.Call[](3);
        _calls[0] = IPersonalAccount.Call(
            address(fxrp), 0, abi.encodeCall(IERC20.approve, (address(market), _collateral))
        );
        _calls[1] = IPersonalAccount.Call(
            address(market), 0, abi.encodeCall(SoftFailingMarket.deposit, (_collateral))
        );
        _calls[2] = IPersonalAccount.Call(
            address(market), 0, abi.encodeCall(SoftFailingMarket.borrow, (_borrow))
        );
    }

    // --- shape and limits -------------------------------------------------------------------

    function test_conditionsAreCheckedBeforeTheExecutorIsPaid() public {
        uint256 fee = 1_000;
        bytes memory payload = abi.encodePacked(
            bytes1(MemoCodec.PAYLOAD_VERSION),
            abi.encode(
                account,
                uint256(0),
                address(fxrp),
                fee,
                _transfer(alice, 10_000),
                _conditions(_pcErc20Balance(address(fxrp), alice, 10_001))
            )
        );
        vm.prank(executor);
        vm.expectRevert();
        controller.execute(_proof(TX_ID, _commit(payload)), payload);
        assertEq(fxrp.balanceOf(executor), 0, "no fee for an instruction that did not deliver");
    }

    function test_malformedConditionsAreRejected() public {
        // A native kind that names a token.
        IPostConditions.PostCondition[] memory bad = new IPostConditions.PostCondition[](1);
        bad[0] = IPostConditions.PostCondition({
            kind: IPostConditions.Kind.NativeBalanceAtLeast,
            token: address(fxrp),
            subject: account,
            threshold: 0,
            extra: ""
        });
        bytes memory payload = _instructionWithConditions(account, 0, _transfer(alice, 1), bad);
        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPostConditions.MalformedPostCondition.selector,
                0,
                IPostConditions.Kind.NativeBalanceAtLeast
            )
        );
        controller.execute(_proof(TX_ID, _commit(payload)), payload);
    }

    function test_tokenKindWithNoTokenIsRejected() public {
        IPostConditions.PostCondition[] memory bad =
            _conditions(_pcErc20Balance(address(0), account, 1));
        bytes memory payload = _instructionWithConditions(account, 0, _transfer(alice, 1), bad);
        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPostConditions.MalformedPostCondition.selector,
                0,
                IPostConditions.Kind.Erc20BalanceAtLeast
            )
        );
        controller.execute(_proof(TX_ID, _commit(payload)), payload);
    }

    function test_theCapIsEnforced() public {
        uint256 n = PostConditions.MAX_POST_CONDITIONS + 1;
        IPostConditions.PostCondition[] memory many = new IPostConditions.PostCondition[](n);
        for (uint256 i = 0; i < n; ++i) {
            many[i] = _pcErc20Balance(address(fxrp), account, 0);
        }
        bytes memory payload = _instructionWithConditions(account, 0, _transfer(alice, 1), many);
        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPostConditions.TooManyPostConditions.selector,
                n,
                PostConditions.MAX_POST_CONDITIONS
            )
        );
        controller.execute(_proof(TX_ID, _commit(payload)), payload);
    }

    function test_theFailingIndexIsReported() public {
        IPostConditions.PostCondition[] memory conds = new IPostConditions.PostCondition[](3);
        conds[0] = _pcErc20Balance(address(fxrp), account, 0);
        conds[1] = _pcErc20Balance(address(fxrp), account, 0);
        conds[2] = _pcErc20Balance(address(fxrp), alice, 999_999);

        bytes memory payload = _instructionWithConditions(account, 0, _transfer(alice, 1), conds);
        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(
                IPostConditions.PostConditionFailed.selector,
                2,
                IPostConditions.Kind.Erc20BalanceAtLeast,
                999_999,
                1
            )
        );
        controller.execute(_proof(TX_ID, _commit(payload)), payload);
    }

    /// @dev A failed post-condition leaves the transaction id unconsumed, so the identical
    ///      proof can be delivered again once the reason is gone. That is the link to rescue:
    ///      nothing needs unsticking, because nothing was spent.
    function test_aFailedInstructionCanBeRetriedUnchanged() public {
        market.setPayOut(false);
        bytes memory payload = _instructionWithConditions(
            account,
            0,
            _depositAndBorrow(50_000_000, 1_000_000),
            _conditions(_pcErc20Delta(address(usd), account, 1_000_000))
        );

        vm.prank(executor);
        vm.expectRevert();
        controller.execute(_proof(TX_ID, _commit(payload)), payload);

        market.setPayOut(true);

        vm.prank(executor);
        controller.execute(_proof(TX_ID, _commit(payload)), payload);
        assertEq(usd.balanceOf(account), 1_000_000, "same proof, same payload, now succeeds");
        assertTrue(controller.isXrplTransactionConsumed(TX_ID));
    }
}
