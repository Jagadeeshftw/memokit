// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IDiamondLoupe} from "./IDiamondLoupe.sol";
import {LibDiamond} from "./LibDiamond.sol";

/// @notice EIP-2535 introspection.
contract DiamondLoupeFacet is IDiamondLoupe {
    /// @inheritdoc IDiamondLoupe
    function facets() external view returns (Facet[] memory _facets) {
        LibDiamond.State storage s = LibDiamond.getState();
        uint256 count = s.facetAddresses.length;
        _facets = new Facet[](count);
        for (uint256 i = 0; i < count; ++i) {
            address facet = s.facetAddresses[i];
            _facets[i] = Facet({facetAddress: facet, functionSelectors: s.facetSelectors[facet]});
        }
    }

    /// @inheritdoc IDiamondLoupe
    function facetFunctionSelectors(address _facet) external view returns (bytes4[] memory) {
        return LibDiamond.getState().facetSelectors[_facet];
    }

    /// @inheritdoc IDiamondLoupe
    function facetAddresses() external view returns (address[] memory) {
        return LibDiamond.getState().facetAddresses;
    }

    /// @inheritdoc IDiamondLoupe
    function facetAddress(bytes4 _selector) external view returns (address) {
        return LibDiamond.getState().facetAddress[_selector];
    }
}
