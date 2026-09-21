// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC1363Receiver} from "@openzeppelin/contracts/interfaces/IERC1363Receiver.sol";
import {ERC1363Utils} from "@openzeppelin/contracts/token/ERC20/utils/ERC1363Utils.sol";

import {MemoKitTestBase} from "./base/MemoKitTestBase.sol";
import {MemoCodec} from "../contracts/libraries/MemoCodec.sol";
import {IPersonalAccount} from "../contracts/interfaces/IPersonalAccount.sol";
import {MockERC1363} from "../contracts/mocks/MockERC1363.sol";

/// @dev A contract that accepts plain transfers but has no ERC-1363 hook: what PersonalAccount
///      was in Phase 1, and what any receiver without `onTransferReceived` is.
contract NoHookReceiver {
    receive() external payable {}
}

/**
 * @title Erc1363ReceiverTest
 * @notice `transferAndCall` into a personal account, matching Flare's `PersonalAccount`.
 *
 * @dev Plain ERC-20 transfers into an account have always worked -- the Phase 1 live trace
 *      depended on one. `transferAndCall` is different: the token calls
 *      `onTransferReceived` on the recipient and reverts unless it returns the magic value, so a
 *      receiver without the hook cannot be paid that way at all.
 */
contract Erc1363ReceiverTest is MemoKitTestBase {
    bytes4 internal constant MAGIC = 0x88a7ca5c; // IERC1363Receiver.onTransferReceived.selector

    MockERC1363 internal token;
    address internal payer = makeAddr("payer");
    address internal account;

    function setUp() public override {
        super.setUp();
        token = new MockERC1363("ERC1363 Test", "T1363", 6);
        token.mint(payer, 100_000_000);
        account = _accountFor(XRPL_SENDER);
    }

    /// @dev Accounts are deployed lazily, by their first instruction. Anything that needs code at
    ///      the address has to run one first.
    function _deployAccount() internal {
        bytes memory payload =
            _instruction(account, 0, _oneCall(address(fxrp), 0, abi.encodeCall(IERC20.approve, (owner, 1))));
        bytes memory memo = abi.encodePacked(_header(MemoCodec.OP_EXEC_COMMIT, 1, uint64(0)), keccak256(payload));
        vm.prank(executor);
        controller.execute(_proof(bytes32(uint256(0xacc)), memo), payload);
        assertGt(account.code.length, 0, "account deployed");
    }

    function test_transferAndCallIntoADeployedAccountSucceeds() public {
        _deployAccount();

        vm.prank(payer);
        token.transferAndCall(account, 25_000_000);

        assertEq(token.balanceOf(account), 25_000_000, "account received the transfer");
        assertEq(token.balanceOf(payer), 75_000_000);
    }

    function test_transferAndCallWithDataSucceeds() public {
        _deployAccount();
        vm.prank(payer);
        token.transferAndCall(account, 1_000_000, hex"c0ffee");
        assertEq(token.balanceOf(account), 1_000_000);
    }

    /// @dev The control. Without the hook the same call reverts, which is what makes the test above
    ///      mean something.
    function test_transferAndCallIntoAReceiverWithoutTheHookReverts() public {
        NoHookReceiver plain = new NoHookReceiver();
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(ERC1363Utils.ERC1363InvalidReceiver.selector, address(plain)));
        token.transferAndCall(address(plain), 1_000_000);
    }

    /// @dev Interface surprise worth pinning. The account address is known before it exists, and a
    ///      plain transfer to it works, but `transferAndCall` requires code at the recipient. Until
    ///      the account's first instruction has run, paying it this way reverts; a plain `transfer`
    ///      is the only way to pre-fund an account that has never been used.
    function test_transferAndCallIntoAnAccountThatDoesNotExistYetReverts() public {
        assertEq(account.code.length, 0, "not deployed");

        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(ERC1363Utils.ERC1363InvalidReceiver.selector, account));
        token.transferAndCall(account, 1_000_000);

        // The plain transfer path -- the one funding has always used -- is unaffected.
        vm.prank(payer);
        token.transfer(account, 1_000_000);
        assertEq(token.balanceOf(account), 1_000_000);
    }

    function test_hookReturnsTheMagicValueForAnyArguments() public {
        _deployAccount();
        IERC1363Receiver hook = IERC1363Receiver(account);

        assertEq(hook.onTransferReceived(address(0), address(0), 0, ""), MAGIC);
        assertEq(hook.onTransferReceived(payer, payer, type(uint256).max, hex"deadbeef"), MAGIC);
    }

    /// @dev The hook is `pure`: an unconditional accept cannot be turned into a way to spend the
    ///      account's assets or change its state. Anyone can call it; nothing moves.
    function test_callingTheHookDirectlyChangesNothing() public {
        _deployAccount();
        fxrp.mint(account, 5_000_000);
        uint256 nonceBefore = controller.nonceOf(account);
        uint256 balanceBefore = fxrp.balanceOf(account);

        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        IERC1363Receiver(account).onTransferReceived(stranger, stranger, 1, "");

        assertEq(fxrp.balanceOf(account), balanceBefore);
        assertEq(controller.nonceOf(account), nonceBefore);
    }

    function test_accountAdvertisesTheReceiverInterface() public {
        _deployAccount();
        IERC165 a = IERC165(account);
        assertEq(type(IERC1363Receiver).interfaceId, MAGIC, "the interface id is the selector");
        assertTrue(a.supportsInterface(type(IERC1363Receiver).interfaceId), "1363 receiver");
        assertTrue(a.supportsInterface(type(IPersonalAccount).interfaceId), "still IPersonalAccount");
        assertTrue(a.supportsInterface(type(IERC165).interfaceId), "still ERC-165");
        assertFalse(a.supportsInterface(0xffffffff), "and still rejects the invalid id");
    }
}
