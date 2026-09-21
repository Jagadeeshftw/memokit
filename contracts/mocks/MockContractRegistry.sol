// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Minimal Flare Contract Registry, etched at the canonical address in tests.
contract MockContractRegistry {
    mapping(bytes32 nameHash => address target) private _addresses;

    function setContractAddress(string memory _name, address _target) external {
        _addresses[keccak256(abi.encode(_name))] = _target;
    }

    function getContractAddressByHash(bytes32 _nameHash) external view returns (address) {
        return _addresses[_nameHash];
    }

    function getContractAddressByName(string calldata _name) external view returns (address) {
        return _addresses[keccak256(abi.encode(_name))];
    }
}
