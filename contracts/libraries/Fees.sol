// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/**
 * @title Fees
 * @notice The token executors are paid in.
 *
 * @dev Flare pays its direct-mint executor out of the freshly minted fAsset. memokit has no
 *      mint, so the executor is paid from what the account already holds -- which is the whole
 *      positioning in miniature. The amount comes from the memo header (or a 0xE2 override);
 *      only the token is configured here.
 *
 *      A zero fee is valid and is the escape hatch: `execute` is permissionless, so an owner
 *      whose account cannot pay can always submit the instruction themselves.
 */
library Fees {
    /// @custom:storage-location erc7201:memokit.Fees.State
    struct State {
        /// @notice ERC-20 executors are paid in. Zero disables fee payment entirely.
        address feeToken;
    }

    bytes32 internal constant STATE_POSITION =
        keccak256(abi.encode(uint256(keccak256("memokit.Fees.State")) - 1)) & ~bytes32(uint256(0xff));

    event FeeTokenSet(address indexed feeToken);

    function setFeeToken(address _feeToken) internal {
        getState().feeToken = _feeToken;
        emit FeeTokenSet(_feeToken);
    }

    function feeToken() internal view returns (address) {
        return getState().feeToken;
    }

    function getState() internal pure returns (State storage _state) {
        bytes32 position = STATE_POSITION;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            _state.slot := position
        }
    }
}
