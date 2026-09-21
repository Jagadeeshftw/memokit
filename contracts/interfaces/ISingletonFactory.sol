// SPDX-License-Identifier: MIT
pragma solidity >=0.8.4 <0.9;

/// @notice EIP-2470 singleton factory, deployed at 0xce0042B868300000d44A59004Da54A005ffdcf9f.
interface ISingletonFactory {
    function deploy(bytes memory _initCode, bytes32 _salt) external returns (address payable);
}
