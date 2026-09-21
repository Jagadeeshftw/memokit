// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IDiamondCut} from "./IDiamondCut.sol";

/**
 * @title LibDiamond
 * @notice Minimal EIP-2535 storage and cut logic.
 * @dev Trimmed reference implementation. Authorisation lives in `DiamondCutFacet`, which
 *      defers to `Governance` -- this library deliberately holds no owner of its own, so
 *      memokit has exactly one notion of "owner".
 */
library LibDiamond {
    /// @custom:storage-location erc7201:memokit.Diamond.State
    struct State {
        mapping(bytes4 selector => address facet) facetAddress;
        mapping(bytes4 selector => uint256 index) selectorIndex;
        bytes4[] selectors;
        mapping(address facet => bytes4[] selectors) facetSelectors;
        address[] facetAddresses;
        mapping(address facet => uint256 index) facetIndex;
    }

    bytes32 internal constant STATE_POSITION =
        keccak256(abi.encode(uint256(keccak256("memokit.Diamond.State")) - 1)) & ~bytes32(uint256(0xff));

    error FunctionNotFound(bytes4 selector);
    error NoSelectors();
    error FacetAddressZero();
    error FacetHasNoCode(address facet);
    error SelectorAlreadyExists(bytes4 selector);
    error SelectorDoesNotExist(bytes4 selector);
    error SameFacet(bytes4 selector);
    error RemoveNeedsZeroAddress(address facet);
    error InitCallFailed(address init, bytes returnData);

    function diamondCut(IDiamondCut.FacetCut[] memory _cuts, address _init, bytes memory _calldata)
        internal
    {
        for (uint256 i = 0; i < _cuts.length; ++i) {
            IDiamondCut.FacetCutAction action = _cuts[i].action;
            bytes4[] memory selectors = _cuts[i].functionSelectors;
            address facet = _cuts[i].facetAddress;
            require(selectors.length > 0, NoSelectors());

            if (action == IDiamondCut.FacetCutAction.Add) {
                _add(facet, selectors);
            } else if (action == IDiamondCut.FacetCutAction.Replace) {
                _replace(facet, selectors);
            } else {
                _remove(facet, selectors);
            }
        }
        emit IDiamondCut.DiamondCut(_cuts, _init, _calldata);
        _initialize(_init, _calldata);
    }

    function _add(address _facet, bytes4[] memory _selectors) private {
        require(_facet != address(0), FacetAddressZero());
        require(_facet.code.length > 0, FacetHasNoCode(_facet));
        State storage s = getState();
        _trackFacet(s, _facet);
        for (uint256 i = 0; i < _selectors.length; ++i) {
            bytes4 selector = _selectors[i];
            require(s.facetAddress[selector] == address(0), SelectorAlreadyExists(selector));
            s.facetAddress[selector] = _facet;
            s.selectorIndex[selector] = s.selectors.length;
            s.selectors.push(selector);
            s.facetSelectors[_facet].push(selector);
        }
    }

    function _replace(address _facet, bytes4[] memory _selectors) private {
        require(_facet != address(0), FacetAddressZero());
        require(_facet.code.length > 0, FacetHasNoCode(_facet));
        State storage s = getState();
        _trackFacet(s, _facet);
        for (uint256 i = 0; i < _selectors.length; ++i) {
            bytes4 selector = _selectors[i];
            address old = s.facetAddress[selector];
            require(old != address(0), SelectorDoesNotExist(selector));
            require(old != _facet, SameFacet(selector));
            _detachSelectorFromFacet(s, old, selector);
            s.facetAddress[selector] = _facet;
            s.facetSelectors[_facet].push(selector);
        }
    }

    function _remove(address _facet, bytes4[] memory _selectors) private {
        require(_facet == address(0), RemoveNeedsZeroAddress(_facet));
        State storage s = getState();
        for (uint256 i = 0; i < _selectors.length; ++i) {
            bytes4 selector = _selectors[i];
            address old = s.facetAddress[selector];
            require(old != address(0), SelectorDoesNotExist(selector));
            _detachSelectorFromFacet(s, old, selector);

            uint256 index = s.selectorIndex[selector];
            uint256 last = s.selectors.length - 1;
            if (index != last) {
                bytes4 moved = s.selectors[last];
                s.selectors[index] = moved;
                s.selectorIndex[moved] = index;
            }
            s.selectors.pop();
            delete s.selectorIndex[selector];
            delete s.facetAddress[selector];
        }
    }

    /// @dev Called before selectors are pushed, so an empty selector list means "not tracked".
    ///      A fully removed facet is popped from `facetAddresses`, so re-adding re-tracks it.
    function _trackFacet(State storage _s, address _facet) private {
        if (_s.facetSelectors[_facet].length == 0) {
            _s.facetIndex[_facet] = _s.facetAddresses.length;
            _s.facetAddresses.push(_facet);
        }
    }

    function _detachSelectorFromFacet(State storage _s, address _facet, bytes4 _selector) private {
        bytes4[] storage list = _s.facetSelectors[_facet];
        uint256 length = list.length;
        for (uint256 i = 0; i < length; ++i) {
            if (list[i] == _selector) {
                list[i] = list[length - 1];
                list.pop();
                break;
            }
        }
        if (list.length == 0) {
            uint256 index = _s.facetIndex[_facet];
            uint256 last = _s.facetAddresses.length - 1;
            if (index != last) {
                address moved = _s.facetAddresses[last];
                _s.facetAddresses[index] = moved;
                _s.facetIndex[moved] = index;
            }
            _s.facetAddresses.pop();
            delete _s.facetIndex[_facet];
        }
    }

    function _initialize(address _init, bytes memory _calldata) private {
        if (_init == address(0)) {
            return;
        }
        require(_init.code.length > 0, FacetHasNoCode(_init));
        (bool ok, bytes memory returnData) = _init.delegatecall(_calldata);
        require(ok, InitCallFailed(_init, returnData));
    }

    function getState() internal pure returns (State storage _state) {
        bytes32 position = STATE_POSITION;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            _state.slot := position
        }
    }
}
