// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test token standing in for FTestXRP.
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory _name, string memory _symbol, uint8 _tokenDecimals)
        ERC20(_name, _symbol)
    {
        _decimals = _tokenDecimals;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address _to, uint256 _amount) external {
        _mint(_to, _amount);
    }
}
