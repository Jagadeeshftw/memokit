// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Always reverts, for asserting that a failing call unwinds the whole instruction.
contract RevertingTarget {
    error Nope(string reason);

    function boom() external pure {
        revert Nope("boom");
    }
}
