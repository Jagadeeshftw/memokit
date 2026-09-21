// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IDiamondCut} from "./IDiamondCut.sol";
import {LibDiamond} from "./LibDiamond.sol";
import {Governance} from "../libraries/Governance.sol";

/// @notice Cut authority, gated on the single memokit owner.
contract DiamondCutFacet is IDiamondCut {
    /// @inheritdoc IDiamondCut
    function diamondCut(FacetCut[] calldata _diamondCut, address _init, bytes calldata _calldata)
        external
    {
        Governance.checkOwner();
        LibDiamond.diamondCut(_diamondCut, _init, _calldata);
    }
}
