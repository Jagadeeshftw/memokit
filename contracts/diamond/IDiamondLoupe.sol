// SPDX-License-Identifier: MIT
pragma solidity >=0.8.4 <0.9;

/// @notice EIP-2535 diamond loupe interface.
interface IDiamondLoupe {
    struct Facet {
        address facetAddress;
        bytes4[] functionSelectors;
    }

    function facets() external view returns (Facet[] memory);

    function facetFunctionSelectors(address _facet) external view returns (bytes4[] memory);

    function facetAddresses() external view returns (address[] memory);

    function facetAddress(bytes4 _selector) external view returns (address);
}
