// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IPersonalAccount} from "../interfaces/IPersonalAccount.sol";

/**
 * @title MemoCodec
 * @notice Decoder for the memokit XRPL memo wire format.
 *
 * @dev The header is byte-for-byte identical to Flare Smart Accounts' memo header, so a wallet
 *      that can already build an FSA memo builds a memokit memo by changing one byte:
 *
 *          byte  0      : opcode
 *          byte  1      : walletId (uint8)
 *          bytes 2..9   : executorFee (uint64, big-endian)
 *          bytes 10..   : opcode-specific payload
 *
 *      Opcode allocation. memokit claims only values FSA leaves free, and reuses FSA's three
 *      recovery opcodes at their original values with their original semantics and lengths.
 *      The receiving XRPL address disambiguates which protocol a memo is addressed to, so
 *      reusing 0xE0/0xE1/0xE2 is unambiguous and maximises wallet compatibility.
 *
 *        | opcode | owner   | payload                              | exact length |
 *        |--------|---------|--------------------------------------|--------------|
 *        | 0xFF   | FSA     | (not ours)                           | --           |
 *        | 0xFE   | FSA     | (not ours)                           | --           |
 *        | 0xFD   | memokit | abi.encode(sender, nonce, Call[])    | 10 + N       |
 *        | 0xFC   | memokit | keccak256(payload)                   | 42           |
 *        | 0xFB   | memokit | reserved                             | --           |
 *        | 0xFA   | memokit | reserved                             | --           |
 *        | 0xF9   | memokit | reserved                             | --           |
 *        | 0xF8   | memokit | reserved                             | --           |
 *        | 0xE2   | shared  | targetTxId (32) + newFee (uint64)    | 50           |
 *        | 0xE1   | shared  | newNonce (uint256)                   | 42           |
 *        | 0xE0   | shared  | targetTxId (bytes32)                 | 42           |
 *        | 0xD1   | FSA     | (not ours -- executor unpin)         | --           |
 *        | 0xD0   | FSA     | (not ours -- executor pin)           | --           |
 *
 *      The instruction payload carried by 0xFD (inline) and committed to by 0xFC (hash) is
 *      `abi.encode(address sender, uint256 nonce, address feeToken, uint256 feeAmount, Call[] calls)`
 *      -- a five-element tuple at the top level, not a wrapped struct. That choice matters: it is
 *      what makes the encoding trivially reproducible by ethers' AbiCoder, and it is pinned by the
 *      conformance fixtures.
 *
 *      The executor fee. Phase 1 read the fee amount from header bytes 2..9 and its token from
 *      controller configuration, which made the account hold a second asset just to pay for
 *      the first. The fee is now part of the payload: it names its own token and amount, so it
 *      is paid in whatever the instruction moves, and it is committed to by the same hash as the
 *      calls it pays for. Header bytes 2..9 keep their place and width -- the header stays
 *      byte-compatible with Flare's -- but are RESERVED and must be zero (see `MemoControllerFacet`,
 *      which rejects anything else). They are not "the amount, in the payload's token": a second
 *      copy of the number would be a second place for it to disagree with the first, and the
 *      recovery opcodes have no payload to name a token at all.
 */
library MemoCodec {
    /// @notice Length of the common header, in bytes.
    uint256 internal constant HEADER_LENGTH = 10;

    /// @notice Execute an instruction carried inline in the memo.
    uint8 internal constant OP_EXEC_INLINE = 0xFD;
    /// @notice Execute an instruction supplied out-of-band, committed to by hash.
    uint8 internal constant OP_EXEC_COMMIT = 0xFC;
    /// @notice Retire a stuck transaction id without dispatching its memo.
    uint8 internal constant OP_IGNORE = 0xE0;
    /// @notice Advance the account's instruction nonce.
    uint8 internal constant OP_SET_NONCE = 0xE1;
    /// @notice Override the executor fee for a specific transaction id.
    uint8 internal constant OP_REPLACE_FEE = 0xE2;

    /// @notice Lower bound of the memokit reserved opcode band (inclusive).
    uint8 internal constant RESERVED_LO = 0xF8;
    /// @notice Upper bound of the memokit reserved opcode band (inclusive).
    uint8 internal constant RESERVED_HI = 0xFB;

    /// @notice Exact memo length for 0xFC, 0xE0 and 0xE1.
    uint256 internal constant LENGTH_WORD = 42;
    /// @notice Exact memo length for 0xE2.
    uint256 internal constant LENGTH_WORD_FEE = 50;

    /// @notice Decoded common header.
    struct Header {
        uint8 opcode;
        uint8 walletId;
        uint64 executorFee;
    }

    /// @notice Reverts when the memo is shorter than the common header.
    error MemoTooShort(uint256 length);
    /// @notice Reverts when a fixed-length opcode carries the wrong number of bytes.
    error InvalidMemoLength(uint8 opcode, uint256 expected, uint256 actual);
    /// @notice Reverts when the opcode is not one memokit implements.
    error UnknownOpcode(uint8 opcode);
    /// @notice Reverts when the opcode falls in memokit's reserved band.
    error ReservedOpcode(uint8 opcode);

    /**
     * @notice Decode the 10-byte common header.
     * @param _memo Raw memo bytes as delivered by the FDC attestation.
     */
    function readHeader(bytes calldata _memo) internal pure returns (Header memory _header) {
        require(_memo.length >= HEADER_LENGTH, MemoTooShort(_memo.length));
        _header.opcode = uint8(_memo[0]);
        _header.walletId = uint8(_memo[1]);
        _header.executorFee = uint64(bytes8(_memo[2:10]));
    }

    /**
     * @notice Read the opcode without decoding the rest of the header.
     * @dev Used before any other validation so a malformed memo can still be recognised.
     */
    function opcode(bytes calldata _memo) internal pure returns (uint8) {
        require(_memo.length >= 1, MemoTooShort(_memo.length));
        return uint8(_memo[0]);
    }

    /// @notice True when `_opcode` is in memokit's reserved band (0xF8..0xFB).
    function isReserved(uint8 _opcode) internal pure returns (bool) {
        return _opcode >= RESERVED_LO && _opcode <= RESERVED_HI;
    }

    /**
     * @notice Payload of an inline (0xFD) memo: everything after the header.
     * @dev Returns a calldata slice; no copy.
     */
    function inlinePayload(bytes calldata _memo) internal pure returns (bytes calldata) {
        require(_memo.length > HEADER_LENGTH, MemoTooShort(_memo.length));
        return _memo[HEADER_LENGTH:];
    }

    /// @notice Commitment carried by a 0xFC memo.
    function commitment(bytes calldata _memo) internal pure returns (bytes32) {
        _requireLength(_memo, OP_EXEC_COMMIT, LENGTH_WORD);
        return bytes32(_memo[HEADER_LENGTH:LENGTH_WORD]);
    }

    /// @notice Target transaction id carried by a 0xE0 memo.
    function ignoreTarget(bytes calldata _memo) internal pure returns (bytes32) {
        _requireLength(_memo, OP_IGNORE, LENGTH_WORD);
        return bytes32(_memo[HEADER_LENGTH:LENGTH_WORD]);
    }

    /// @notice New nonce carried by a 0xE1 memo.
    function newNonce(bytes calldata _memo) internal pure returns (uint256) {
        _requireLength(_memo, OP_SET_NONCE, LENGTH_WORD);
        return uint256(bytes32(_memo[HEADER_LENGTH:LENGTH_WORD]));
    }

    /// @notice Target transaction id and replacement fee carried by a 0xE2 memo.
    function replacementFee(bytes calldata _memo)
        internal
        pure
        returns (bytes32 _targetTxId, uint64 _newFee)
    {
        _requireLength(_memo, OP_REPLACE_FEE, LENGTH_WORD_FEE);
        _targetTxId = bytes32(_memo[HEADER_LENGTH:LENGTH_WORD]);
        _newFee = uint64(bytes8(_memo[LENGTH_WORD:LENGTH_WORD_FEE]));
    }

    /**
     * @notice Decode an instruction payload.
     * @dev The payload is `abi.encode(address, uint256, address, uint256, Call[])`. A malformed
     *      payload reverts inside `abi.decode`; callers treat that as an invalid instruction.
     * @return _sender The account the instruction claims to act for.
     * @return _nonce The account nonce it is bound to.
     * @return _feeToken The token the executor is paid in. Ignored when `_feeAmount` is zero.
     * @return _feeAmount The executor fee, in `_feeToken` base units. Zero means no fee.
     * @return _calls The calls to execute, in order.
     */
    function decodeInstruction(bytes memory _payload)
        internal
        pure
        returns (
            address _sender,
            uint256 _nonce,
            address _feeToken,
            uint256 _feeAmount,
            IPersonalAccount.Call[] memory _calls
        )
    {
        (_sender, _nonce, _feeToken, _feeAmount, _calls) =
            abi.decode(_payload, (address, uint256, address, uint256, IPersonalAccount.Call[]));
    }

    function _requireLength(bytes calldata _memo, uint8 _opcode, uint256 _expected) private pure {
        require(_memo.length == _expected, InvalidMemoLength(_opcode, _expected, _memo.length));
    }
}
