// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice A target that fails with (or succeeds returning) an arbitrarily large blob. Test-only.
///         Models an owner who wants a UserOp that is expensive for the executor to run and
///         then reverts, so the executor pays and the owner does not.
contract RevertBomb {
    function boom(uint256 _bytes) external pure {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            revert(0, _bytes)
        }
    }

    function bloat(uint256 _bytes) external pure returns (bytes memory) {
        return new bytes(_bytes);
    }
}
