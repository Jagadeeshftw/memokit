// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ContractRegistry} from "flare-periphery/coston2/ContractRegistry.sol";
import {IXRPPayment} from "flare-periphery/coston2/IXRPPayment.sol";

/**
 * @title Proofs
 * @notice Validation of FDC `XRPPayment` attestations.
 *
 * @dev memokit uses `XRPPayment`, not the classic `Payment` attestation. `Payment` only yields a
 *      `standardPaymentReference` when the transaction carries exactly one memo of exactly 32
 *      bytes, which caps an instruction at 32 bytes. `XRPPayment` returns `bytes firstMemoData`
 *      verbatim, so the instruction is bounded only by XRPL's ~1 KB memo ceiling.
 *
 *      The receiving-address registry is an owner-managed set rather than Flare's single
 *      hardcoded address, but it is still a registry: an arbitrary XRPL address cannot drive
 *      this contract.
 *
 *      The periphery ships one copy of these interfaces per network; the Flare Contract Registry
 *      lives at the same address on all four, so the `coston2` copy is correct everywhere.
 */
library Proofs {
    /// @custom:storage-location erc7201:memokit.Proofs.State
    struct State {
        /// @notice FDC source id, e.g. bytes32("testXRP").
        bytes32 sourceId;
        /// @notice How long after the XRPL block timestamp a proof stays usable.
        uint64 validityDurationSeconds;
        /// @notice 1-based index into `receivingAddresses`; 0 means "not registered".
        mapping(bytes32 addressHash => uint256 index) receivingAddressIndex;
        /// @notice Registered receiving addresses, for enumeration.
        string[] receivingAddresses;
    }

    bytes32 internal constant STATE_POSITION =
        keccak256(abi.encode(uint256(keccak256("memokit.Proofs.State")) - 1)) & ~bytes32(uint256(0xff));

    event SourceIdSet(bytes32 sourceId);
    event ValidityDurationSet(uint64 durationSeconds);
    event ReceivingAddressAdded(string xrplAddress, bytes32 indexed addressHash);
    event ReceivingAddressRemoved(string xrplAddress, bytes32 indexed addressHash);

    error InvalidSourceId(bytes32 expected, bytes32 actual);
    error UnsuccessfulTransaction(uint8 status);
    error ProofExpired(uint64 blockTimestamp, uint64 validUntil);
    error DestinationTagNotAllowed(uint256 destinationTag);
    error ReceivingAddressNotRegistered(bytes32 addressHash);
    error SourceAddressMismatch(bytes32 expected, bytes32 actual);
    error NoMemoData();
    error InvalidProof();
    error AlreadyRegistered();
    error NotRegistered();
    error ValidityDurationZero();

    /**
     * @notice Run every check memokit makes on an attestation before acting on it.
     * @dev Ordered cheapest-first; the FDC Merkle verification is last because it is the
     *      most expensive.
     * @param _proof The FDC XRPPayment proof.
     * @return _sourceAddress The XRPL address that sent the payment.
     * @return _memoData The raw first memo.
     */
    function verify(IXRPPayment.Proof calldata _proof)
        internal
        view
        returns (string calldata _sourceAddress, bytes calldata _memoData)
    {
        State storage state = getState();
        IXRPPayment.ResponseBody calldata body = _proof.data.responseBody;

        require(_proof.data.sourceId == state.sourceId, InvalidSourceId(state.sourceId, _proof.data.sourceId));
        require(body.status == 0, UnsuccessfulTransaction(body.status));

        uint64 validUntil = body.blockTimestamp + state.validityDurationSeconds;
        require(block.timestamp <= validUntil, ProofExpired(body.blockTimestamp, validUntil));

        // A destination tag on the payment lets a third party buy the tag upstream and
        // front-run the user. Flare forbids tags by convention; XRPPayment lets us assert it.
        require(!body.hasDestinationTag, DestinationTagNotAllowed(body.destinationTag));

        require(
            state.receivingAddressIndex[body.receivingAddressHash] != 0,
            ReceivingAddressNotRegistered(body.receivingAddressHash)
        );

        // XRPPayment carries both the address and its hash. Assert they agree before trusting
        // the string to derive an account address.
        bytes32 derived = keccak256(bytes(body.sourceAddress));
        require(derived == body.sourceAddressHash, SourceAddressMismatch(body.sourceAddressHash, derived));

        require(body.hasMemoData, NoMemoData());

        require(ContractRegistry.getFdcVerification().verifyXRPPayment(_proof), InvalidProof());

        return (body.sourceAddress, body.firstMemoData);
    }

    function setSourceId(bytes32 _sourceId) internal {
        getState().sourceId = _sourceId;
        emit SourceIdSet(_sourceId);
    }

    function setValidityDuration(uint64 _durationSeconds) internal {
        require(_durationSeconds > 0, ValidityDurationZero());
        getState().validityDurationSeconds = _durationSeconds;
        emit ValidityDurationSet(_durationSeconds);
    }

    function addReceivingAddress(string memory _xrplAddress) internal {
        State storage state = getState();
        bytes32 h = keccak256(bytes(_xrplAddress));
        require(state.receivingAddressIndex[h] == 0, AlreadyRegistered());
        state.receivingAddresses.push(_xrplAddress);
        state.receivingAddressIndex[h] = state.receivingAddresses.length; // 1-based
        emit ReceivingAddressAdded(_xrplAddress, h);
    }

    function removeReceivingAddress(string memory _xrplAddress) internal {
        State storage state = getState();
        bytes32 h = keccak256(bytes(_xrplAddress));
        uint256 index = state.receivingAddressIndex[h];
        require(index != 0, NotRegistered());

        uint256 last = state.receivingAddresses.length;
        if (index != last) {
            string memory moved = state.receivingAddresses[last - 1];
            state.receivingAddresses[index - 1] = moved;
            state.receivingAddressIndex[keccak256(bytes(moved))] = index;
        }
        state.receivingAddresses.pop();
        delete state.receivingAddressIndex[h];
        emit ReceivingAddressRemoved(_xrplAddress, h);
    }

    function getState() internal pure returns (State storage _state) {
        bytes32 position = STATE_POSITION;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            _state.slot := position
        }
    }
}
