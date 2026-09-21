// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IDiamondCut} from "../../contracts/diamond/IDiamondCut.sol";
import {DiamondLoupeFacet} from "../../contracts/diamond/DiamondLoupeFacet.sol";
import {AccountsFacet} from "../../contracts/facets/AccountsFacet.sol";
import {AdminFacet} from "../../contracts/facets/AdminFacet.sol";
import {MemoControllerFacet} from "../../contracts/facets/MemoControllerFacet.sol";

/**
 * @title FacetSelectors
 * @notice Single definition of which selectors belong to which facet.
 * @dev Shared by the deploy script and the test harness so a facet cannot gain a function
 *      in one and lose it in the other -- the failure mode being a deployment that works in
 *      tests and reverts with `FunctionNotFound` on chain.
 */
library FacetSelectors {
    function controller() internal pure returns (bytes4[] memory _s) {
        _s = new bytes4[](5);
        _s[0] = MemoControllerFacet.execute.selector;
        _s[1] = MemoControllerFacet.nonceOf.selector;
        _s[2] = MemoControllerFacet.isTransactionIdUsed.selector;
        _s[3] = MemoControllerFacet.isIgnored.selector;
        _s[4] = MemoControllerFacet.replacementFeeOf.selector;
    }

    function accounts() internal pure returns (bytes4[] memory _s) {
        _s = new bytes4[](4);
        _s[0] = AccountsFacet.accountBeacon.selector;
        _s[1] = AccountsFacet.accountOf.selector;
        _s[2] = AccountsFacet.computeAccountAddress.selector;
        _s[3] = AccountsFacet.accountProxyCodeHash.selector;
    }

    function loupe() internal pure returns (bytes4[] memory _s) {
        _s = new bytes4[](4);
        _s[0] = DiamondLoupeFacet.facets.selector;
        _s[1] = DiamondLoupeFacet.facetFunctionSelectors.selector;
        _s[2] = DiamondLoupeFacet.facetAddresses.selector;
        _s[3] = DiamondLoupeFacet.facetAddress.selector;
    }

    function admin() internal pure returns (bytes4[] memory _s) {
        _s = new bytes4[](25);
        _s[0] = AdminFacet.initializeMemoKit.selector;
        _s[1] = AdminFacet.setSourceId.selector;
        _s[2] = AdminFacet.setValidityDuration.selector;
        _s[3] = AdminFacet.setFeeToken.selector;
        _s[4] = AdminFacet.setAccountImplementation.selector;
        _s[5] = AdminFacet.setTimelockDuration.selector;
        _s[6] = AdminFacet.transferOwnership.selector;
        _s[7] = AdminFacet.addReceivingAddress.selector;
        _s[8] = AdminFacet.removeReceivingAddress.selector;
        _s[9] = AdminFacet.setPauser.selector;
        _s[10] = AdminFacet.setUnpauser.selector;
        _s[11] = AdminFacet.pause.selector;
        _s[12] = AdminFacet.unpause.selector;
        _s[13] = AdminFacet.owner.selector;
        _s[14] = AdminFacet.timelockDurationSeconds.selector;
        _s[15] = AdminFacet.scheduledAt.selector;
        _s[16] = AdminFacet.paused.selector;
        _s[17] = AdminFacet.isPauser.selector;
        _s[18] = AdminFacet.isUnpauser.selector;
        _s[19] = AdminFacet.sourceId.selector;
        _s[20] = AdminFacet.validityDurationSeconds.selector;
        _s[21] = AdminFacet.feeToken.selector;
        _s[22] = AdminFacet.accountImplementation.selector;
        _s[23] = AdminFacet.receivingAddresses.selector;
        _s[24] = AdminFacet.isReceivingAddress.selector;
    }

    function add(address _facet, bytes4[] memory _selectors)
        internal
        pure
        returns (IDiamondCut.FacetCut memory)
    {
        return IDiamondCut.FacetCut({
            facetAddress: _facet,
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: _selectors
        });
    }
}
