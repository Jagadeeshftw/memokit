// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IDiamondCut} from "./IDiamondCut.sol";
import {LibDiamond} from "./LibDiamond.sol";
import {Governance} from "../libraries/Governance.sol";

/**
 * @title Diamond
 * @notice The memokit controller. Holds all protocol state; every behaviour is a facet.
 * @dev The owner is set here so `DiamondCutFacet` has an authority from block one;
 *      `AdminFacet.initializeMemoKit` fills in the rest of the configuration afterwards.
 */
contract Diamond {
    error FunctionNotFound(bytes4 selector);

    constructor(address _owner, address _diamondCutFacet) {
        Governance.setOwner(_owner);

        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = IDiamondCut.diamondCut.selector;

        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](1);
        cut[0] = IDiamondCut.FacetCut({
            facetAddress: _diamondCutFacet,
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: selectors
        });

        LibDiamond.diamondCut(cut, address(0), "");
    }

    // solhint-disable-next-line no-complex-fallback
    fallback() external payable {
        address facet = LibDiamond.getState().facetAddress[msg.sig];
        require(facet != address(0), FunctionNotFound(msg.sig));
        // solhint-disable-next-line no-inline-assembly
        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), facet, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    receive() external payable {}
}
