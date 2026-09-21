// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MemoKitTestBase} from "./base/MemoKitTestBase.sol";
import {AdminFacet} from "../contracts/facets/AdminFacet.sol";
import {Governance} from "../contracts/libraries/Governance.sol";
import {Pause} from "../contracts/libraries/Pause.sol";
import {Proofs} from "../contracts/libraries/Proofs.sol";

/**
 * @title GovernanceTest
 * @notice The timelocked/immediate split, and who may do what.
 * @dev Mirrors Flare's reasoning: economic and trust-changing parameters wait; operational
 *      and emergency levers do not.
 */
contract GovernanceTest is MemoKitTestBase {
    function test_ownerIsSetByConstructorAndInit() public view {
        assertEq(admin.owner(), owner);
        assertEq(admin.timelockDurationSeconds(), TIMELOCK_SECONDS);
        assertEq(admin.sourceId(), SOURCE_ID);
        assertEq(admin.validityDurationSeconds(), VALIDITY_SECONDS);
        assertEq(admin.feeToken(), address(fxrp));
        assertTrue(admin.isPauser(pauser));
        assertTrue(admin.isUnpauser(pauser));
    }

    function test_cannotInitializeTwice() public {
        string[] memory none = new string[](0);
        address[] memory noneAddr = new address[](0);
        vm.prank(owner);
        vm.expectRevert(AdminFacet.AlreadyInitialized.selector);
        admin.initializeMemoKit(
            AdminFacet.InitParams({
                owner: owner,
                accountBeacon: address(beacon),
                sourceId: SOURCE_ID,
                validityDurationSeconds: 1,
                timelockDurationSeconds: 1,
                feeToken: address(0),
                receivingAddresses: none,
                pausers: noneAddr,
                unpausers: noneAddr
            })
        );
    }

    // --- timelocked ---------------------------------------------------------------------

    function test_timelockedSetterSchedulesThenExecutes() public {
        bytes32 newSource = bytes32("XRP");

        vm.prank(owner);
        admin.setSourceId(newSource);
        assertEq(admin.sourceId(), SOURCE_ID, "not applied on the scheduling call");

        bytes32 callHash = keccak256(abi.encodeCall(AdminFacet.setSourceId, (newSource)));
        assertEq(admin.scheduledAt(callHash), block.timestamp + TIMELOCK_SECONDS);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                Governance.TimelockNotElapsed.selector, callHash, block.timestamp + TIMELOCK_SECONDS
            )
        );
        admin.setSourceId(newSource);

        vm.warp(block.timestamp + TIMELOCK_SECONDS);
        vm.prank(owner);
        admin.setSourceId(newSource);
        assertEq(admin.sourceId(), newSource, "applied after the delay");
        assertEq(admin.scheduledAt(callHash), 0, "schedule cleared");
    }

    /// @dev Scheduling commits to the exact arguments, so a different value is a new schedule.
    function test_timelockIsKeyedByArguments() public {
        vm.startPrank(owner);
        admin.setValidityDuration(111);
        vm.warp(block.timestamp + TIMELOCK_SECONDS);

        admin.setValidityDuration(222); // schedules, does not execute the 111 schedule
        assertEq(admin.validityDurationSeconds(), VALIDITY_SECONDS);

        admin.setValidityDuration(111); // this one is due
        assertEq(admin.validityDurationSeconds(), 111);
        vm.stopPrank();
    }

    function test_timelockedSetterRejectsNonOwner() public {
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(Governance.OnlyOwner.selector, executor));
        admin.setFeeToken(address(0));
    }

    function test_ownershipTransferIsTimelocked() public {
        address next = makeAddr("nextOwner");
        vm.startPrank(owner);
        admin.transferOwnership(next);
        assertEq(admin.owner(), owner, "still the old owner");
        vm.warp(block.timestamp + TIMELOCK_SECONDS);
        admin.transferOwnership(next);
        vm.stopPrank();
        assertEq(admin.owner(), next);
    }

    // --- immediate ----------------------------------------------------------------------

    function test_receivingAddressRegistryIsImmediate() public {
        string memory extra = "rSecondOperatorWalletXXXXXXXXXXXXXX";

        vm.prank(owner);
        admin.addReceivingAddress(extra);
        assertTrue(admin.isReceivingAddress(extra), "applied at once");
        assertEq(admin.receivingAddresses().length, 2);

        vm.prank(owner);
        admin.removeReceivingAddress(extra);
        assertFalse(admin.isReceivingAddress(extra));
        assertEq(admin.receivingAddresses().length, 1);
        assertTrue(admin.isReceivingAddress(RECEIVING), "survivor kept");
    }

    function test_receivingAddressRegistryRejectsNonOwner() public {
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(Governance.OnlyOwner.selector, executor));
        admin.addReceivingAddress("rXXX");
    }

    function test_cannotAddTheSameReceivingAddressTwice() public {
        vm.prank(owner);
        vm.expectRevert(Proofs.AlreadyRegistered.selector);
        admin.addReceivingAddress(RECEIVING);
    }

    function test_cannotRemoveAnUnregisteredReceivingAddress() public {
        vm.prank(owner);
        vm.expectRevert(Proofs.NotRegistered.selector);
        admin.removeReceivingAddress("rNotThereXXXXXXXXXXXXXXXXXXXXXXXXX");
    }

    // --- pause --------------------------------------------------------------------------

    function test_onlyPauserMayPause() public {
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(Pause.NotPauser.selector, executor));
        admin.pause();

        vm.prank(pauser);
        admin.pause();
        assertTrue(admin.paused());
    }

    function test_onlyUnpauserMayUnpause() public {
        vm.prank(pauser);
        admin.pause();

        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(Pause.NotUnpauser.selector, executor));
        admin.unpause();

        vm.prank(pauser);
        admin.unpause();
        assertFalse(admin.paused());
    }

    /// @dev Pauser and unpauser are separate sets so the emergency stop can be delegated
    ///      more widely than the restart.
    function test_pauserAndUnpauserSetsAreIndependent() public {
        address stopOnly = makeAddr("stopOnly");
        vm.prank(owner);
        admin.setPauser(stopOnly, true);

        assertTrue(admin.isPauser(stopOnly));
        assertFalse(admin.isUnpauser(stopOnly));

        vm.prank(stopOnly);
        admin.pause();

        vm.prank(stopOnly);
        vm.expectRevert(abi.encodeWithSelector(Pause.NotUnpauser.selector, stopOnly));
        admin.unpause();
    }
}
