// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Accounts} from "../libraries/Accounts.sol";
import {PersonalAccountBeacon} from "../accounts/PersonalAccountBeacon.sol";
import {Fees} from "../libraries/Fees.sol";
import {Governance} from "../libraries/Governance.sol";
import {Pause} from "../libraries/Pause.sol";
import {Proofs} from "../libraries/Proofs.sol";

/**
 * @title AdminFacet
 * @notice Configuration, ownership, timelock and pause.
 *
 * @dev The timelocked/immediate split mirrors Flare Smart Accounts on purpose:
 *
 *        timelocked -- economic or trust-changing: fee token, source id, proof validity
 *                      window, account implementation, ownership, timelock duration itself.
 *        immediate  -- operational or emergency: the receiving-address registry, pauser
 *                      membership, pause and unpause.
 *
 *      Flare's reasoning for not timelocking executor rotation was that a compromised key
 *      must be replaceable at once. memokit has no privileged executor to rotate, so the
 *      equivalent fast path is the receiving-address registry: an address that starts
 *      misbehaving operationally has to be removable without a delay.
 */
contract AdminFacet {
    /// @notice One-time setup parameters.
    struct InitParams {
        address owner;
        address accountBeacon;
        bytes32 sourceId;
        uint64 validityDurationSeconds;
        uint64 timelockDurationSeconds;
        address feeToken;
        string[] receivingAddresses;
        address[] pausers;
        address[] unpausers;
    }

    error AlreadyInitialized();

    event Initialized(address indexed owner, bytes32 sourceId);

    modifier onlyOwner() {
        Governance.checkOwner();
        _;
    }

    /// @dev Schedules on the first call and runs on the second, once the delay has elapsed.
    modifier timelocked() {
        if (Governance.checkTimelock()) {
            _;
        }
    }

    /// @notice Configure a fresh deployment. Owner-only, callable once.
    function initializeMemoKit(InitParams calldata _params) external onlyOwner {
        Governance.State storage governance = Governance.getState();
        require(!governance.initialized, AlreadyInitialized());
        governance.initialized = true;

        Governance.setOwner(_params.owner);
        Accounts.setBeacon(_params.accountBeacon);
        Proofs.setSourceId(_params.sourceId);
        Proofs.setValidityDuration(_params.validityDurationSeconds);
        Fees.setFeeToken(_params.feeToken);

        for (uint256 i = 0; i < _params.receivingAddresses.length; ++i) {
            Proofs.addReceivingAddress(_params.receivingAddresses[i]);
        }
        for (uint256 i = 0; i < _params.pausers.length; ++i) {
            Pause.setPauser(_params.pausers[i], true);
        }
        for (uint256 i = 0; i < _params.unpausers.length; ++i) {
            Pause.setUnpauser(_params.unpausers[i], true);
        }

        // Set last so that every setter above runs without a delay during setup.
        Governance.setTimelockDuration(_params.timelockDurationSeconds);

        emit Initialized(_params.owner, _params.sourceId);
    }

    // --- timelocked ---------------------------------------------------------------------

    function setSourceId(bytes32 _sourceId) external timelocked {
        Proofs.setSourceId(_sourceId);
    }

    function setValidityDuration(uint64 _durationSeconds) external timelocked {
        Proofs.setValidityDuration(_durationSeconds);
    }

    function setFeeToken(address _feeToken) external timelocked {
        Fees.setFeeToken(_feeToken);
    }

    /// @dev Upgrades every account at once, via the beacon. The beacon address itself is
    ///      fixed at initialisation because it is part of each account's CREATE2 init code.
    function setAccountImplementation(address _implementation) external timelocked {
        PersonalAccountBeacon(Accounts.getState().beacon).setImplementation(_implementation);
    }

    function setTimelockDuration(uint64 _durationSeconds) external timelocked {
        Governance.setTimelockDuration(_durationSeconds);
    }

    function transferOwnership(address _newOwner) external timelocked {
        Governance.setOwner(_newOwner);
    }

    // --- immediate ----------------------------------------------------------------------

    function addReceivingAddress(string calldata _xrplAddress) external onlyOwner {
        Proofs.addReceivingAddress(_xrplAddress);
    }

    function removeReceivingAddress(string calldata _xrplAddress) external onlyOwner {
        Proofs.removeReceivingAddress(_xrplAddress);
    }

    function setPauser(address _account, bool _allowed) external onlyOwner {
        Pause.setPauser(_account, _allowed);
    }

    function setUnpauser(address _account, bool _allowed) external onlyOwner {
        Pause.setUnpauser(_account, _allowed);
    }

    function pause() external {
        Pause.pause();
    }

    function unpause() external {
        Pause.unpause();
    }

    // --- views --------------------------------------------------------------------------

    function owner() external view returns (address) {
        return Governance.getState().owner;
    }

    function timelockDurationSeconds() external view returns (uint64) {
        return Governance.getState().timelockDurationSeconds;
    }

    function scheduledAt(bytes32 _callHash) external view returns (uint256) {
        return Governance.getState().scheduled[_callHash];
    }

    function paused() external view returns (bool) {
        return Pause.getState().paused;
    }

    function isPauser(address _account) external view returns (bool) {
        return Pause.getState().pausers[_account];
    }

    function isUnpauser(address _account) external view returns (bool) {
        return Pause.getState().unpausers[_account];
    }

    function sourceId() external view returns (bytes32) {
        return Proofs.getState().sourceId;
    }

    function validityDurationSeconds() external view returns (uint64) {
        return Proofs.getState().validityDurationSeconds;
    }

    function feeToken() external view returns (address) {
        return Fees.feeToken();
    }

    /// @dev The beacon address itself is exposed by `AccountsFacet`, not here: two facets
    ///      declaring the same selector cannot be cut into one diamond.
    function accountImplementation() external view returns (address) {
        return PersonalAccountBeacon(Accounts.getState().beacon).implementation();
    }

    function receivingAddresses() external view returns (string[] memory) {
        return Proofs.getState().receivingAddresses;
    }

    function isReceivingAddress(string calldata _xrplAddress) external view returns (bool) {
        return Proofs.getState().receivingAddressIndex[keccak256(bytes(_xrplAddress))] != 0;
    }
}
