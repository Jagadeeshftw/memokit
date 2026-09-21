// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/**
 * @notice Behavioural stand-in for the EIP-2470 singleton factory, for tests and local chains.
 * @dev Account addresses depend on (factory address, salt, init code hash) only, never on the
 *      factory's own code, so etching this at the canonical address reproduces real addresses.
 */
contract MockSingletonFactory {
    function deploy(bytes memory _initCode, bytes32 _salt) external returns (address payable _created) {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            _created := create2(0, add(_initCode, 0x20), mload(_initCode), _salt)
        }
    }
}
