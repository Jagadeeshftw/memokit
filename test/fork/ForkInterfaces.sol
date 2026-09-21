// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @dev Only what the fork tests call, transcribed from the live contracts and checked by the
///      calls succeeding against them. Kinetic is a Compound v2 fork; SparkDEX is a Uniswap V3 fork
///      with a Uniswap UniversalRouter.
interface IKComptroller {
    function getAllMarkets() external view returns (address[] memory);
    function enterMarkets(address[] calldata kTokens) external returns (uint256[] memory);
    function checkMembership(address account, address kToken) external view returns (bool);
    function getAccountLiquidity(address account) external view returns (uint256 err, uint256 liquidity, uint256 shortfall);
    function markets(address kToken) external view returns (bool isListed, uint256 collateralFactorMantissa);
}

interface IKToken {
    function underlying() external view returns (address);
    function symbol() external view returns (string memory);
    function mint(uint256 mintAmount) external returns (uint256);
    function borrow(uint256 borrowAmount) external returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function exchangeRateStored() external view returns (uint256);
    function borrowBalanceStored(address) external view returns (uint256);
    function getCash() external view returns (uint256);
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate);
}
