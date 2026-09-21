// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MemoCodec} from "../../contracts/libraries/MemoCodec.sol";
import {IPersonalAccount} from "../../contracts/interfaces/IPersonalAccount.sol";
import {IPostConditions} from "../../contracts/interfaces/IPostConditions.sol";

/// @notice External wrapper so tests can drive `MemoCodec`'s calldata-taking functions.
contract MemoCodecHarness {
    function readHeader(bytes calldata _memo) external pure returns (MemoCodec.Header memory) {
        return MemoCodec.readHeader(_memo);
    }

    function opcode(bytes calldata _memo) external pure returns (uint8) {
        return MemoCodec.opcode(_memo);
    }

    function isReserved(uint8 _opcode) external pure returns (bool) {
        return MemoCodec.isReserved(_opcode);
    }

    function inlinePayload(bytes calldata _memo) external pure returns (bytes memory) {
        return MemoCodec.inlinePayload(_memo);
    }

    function commitment(bytes calldata _memo) external pure returns (bytes32) {
        return MemoCodec.commitment(_memo);
    }

    function ignoreTarget(bytes calldata _memo) external pure returns (bytes32) {
        return MemoCodec.ignoreTarget(_memo);
    }

    function newNonce(bytes calldata _memo) external pure returns (uint256) {
        return MemoCodec.newNonce(_memo);
    }

    function replacementFee(bytes calldata _memo) external pure returns (bytes32, uint64) {
        return MemoCodec.replacementFee(_memo);
    }

    function decodeInstruction(bytes calldata _payload)
        external
        pure
        returns (
            address _sender,
            uint256 _nonce,
            address _feeToken,
            uint256 _feeAmount,
            uint256 _callCount,
            uint256 _postConditionCount
        )
    {
        IPersonalAccount.Call[] memory calls;
        IPostConditions.PostCondition[] memory conditions;
        (_sender, _nonce, _feeToken, _feeAmount, calls, conditions) =
            MemoCodec.decodeInstruction(_payload);
        _callCount = calls.length;
        _postConditionCount = conditions.length;
    }

    function payloadVersion(bytes calldata _payload) external pure returns (uint8) {
        return MemoCodec.payloadVersion(_payload);
    }

    /// @notice Decode a single post-condition, for field-level assertions.
    function postConditionAt(bytes calldata _payload, uint256 _index)
        external
        pure
        returns (
            uint8 _kind,
            address _token,
            address _subject,
            uint256 _threshold,
            bytes memory _extra
        )
    {
        (,,,,, IPostConditions.PostCondition[] memory conditions) =
            MemoCodec.decodeInstruction(_payload);
        IPostConditions.PostCondition memory c = conditions[_index];
        return (uint8(c.kind), c.token, c.subject, c.threshold, c.extra);
    }

    /**
     * @notice Decode then re-encode an instruction payload.
     * @dev The returned bytes must equal the input exactly. That is the byte-level proof that
     *      Solidity's version byte plus `abi.encode(address, uint256, address, uint256, Call[],
     *      PostCondition[])` and ethers' encoding of the same thing produce identical output --
     *      the property the TS encoder relies on.
     */
    function roundTripInstruction(bytes calldata _payload) external pure returns (bytes memory) {
        (
            address sender,
            uint256 nonce,
            address feeToken,
            uint256 feeAmount,
            IPersonalAccount.Call[] memory calls,
            IPostConditions.PostCondition[] memory conditions
        ) = MemoCodec.decodeInstruction(_payload);
        return abi.encodePacked(
            bytes1(MemoCodec.PAYLOAD_VERSION),
            abi.encode(sender, nonce, feeToken, feeAmount, calls, conditions)
        );
    }

    /// @notice Decode a single call out of a payload, for field-level assertions.
    function callAt(bytes calldata _payload, uint256 _index)
        external
        pure
        returns (address _target, uint256 _value, bytes memory _data)
    {
        (,,,, IPersonalAccount.Call[] memory calls,) = MemoCodec.decodeInstruction(_payload);
        return (calls[_index].target, calls[_index].value, calls[_index].data);
    }
}
