// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MemoCodec} from "../../contracts/libraries/MemoCodec.sol";
import {IPersonalAccount} from "../../contracts/interfaces/IPersonalAccount.sol";

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
        returns (address _sender, uint256 _nonce, uint256 _callCount)
    {
        IPersonalAccount.Call[] memory calls;
        (_sender, _nonce, calls) = MemoCodec.decodeInstruction(_payload);
        _callCount = calls.length;
    }

    /**
     * @notice Decode then re-encode an instruction payload.
     * @dev The returned bytes must equal the input exactly. That is the byte-level proof that
     *      Solidity's `abi.encode(address, uint256, Call[])` and ethers' `AbiCoder.encode` of
     *      the same tuple produce identical output -- the property the TS encoder relies on.
     */
    function roundTripInstruction(bytes calldata _payload) external pure returns (bytes memory) {
        (address sender, uint256 nonce, IPersonalAccount.Call[] memory calls) =
            MemoCodec.decodeInstruction(_payload);
        return abi.encode(sender, nonce, calls);
    }

    /// @notice Decode a single call out of a payload, for field-level assertions.
    function callAt(bytes calldata _payload, uint256 _index)
        external
        pure
        returns (address _target, uint256 _value, bytes memory _data)
    {
        (,, IPersonalAccount.Call[] memory calls) = MemoCodec.decodeInstruction(_payload);
        return (calls[_index].target, calls[_index].value, calls[_index].data);
    }
}
