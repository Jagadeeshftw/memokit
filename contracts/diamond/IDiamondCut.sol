// SPDX-License-Identifier: MIT
pragma solidity >=0.8.4 <0.9;

/// @notice EIP-2535 diamond cut interface.
interface IDiamondCut {
    enum FacetCutAction {
        Add,
        Replace,
        Remove
    }

    struct FacetCut {
        address facetAddress;
        FacetCutAction action;
        bytes4[] functionSelectors;
    }

    event DiamondCut(FacetCut[] diamondCut, address init, bytes initCalldata);

    /**
     * @notice Add, replace or remove facet functions, optionally running an initialiser.
     * @param _diamondCut The cuts to apply.
     * @param _init Address to delegatecall after cutting, or the zero address.
     * @param _calldata Calldata for `_init`.
     */
    function diamondCut(FacetCut[] calldata _diamondCut, address _init, bytes calldata _calldata) external;
}
