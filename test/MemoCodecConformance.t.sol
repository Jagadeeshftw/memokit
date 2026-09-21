// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {MemoCodecHarness} from "./harness/MemoCodecHarness.sol";
import {MemoCodec} from "../contracts/libraries/MemoCodec.sol";
import {IPersonalAccount} from "../contracts/interfaces/IPersonalAccount.sol";

/**
 * @title MemoCodecConformance
 * @notice Proves the Solidity decoder agrees with the TypeScript encoder, byte for byte.
 *
 * @dev Both sides read `fixtures/memo-wire.json`, which the TS side generates
 *      (`npm run fixtures`). If the two implementations ever drift, one of these fails.
 *      This is the highest-value test in the repo: a codec mismatch produces a memo that
 *      looks fine in a wallet and then executes the wrong thing, or nothing, on chain.
 */
contract MemoCodecConformanceTest is Test {
    MemoCodecHarness internal harness;
    string internal json;
    uint256 internal count;

    function setUp() public {
        harness = new MemoCodecHarness();
        json = vm.readFile("fixtures/memo-wire.json");
        count = vm.parseJsonUint(json, ".count");
        assertGt(count, 0, "no fixtures; run `npm run fixtures`");
    }

    function _path(uint256 _i, string memory _field) internal pure returns (string memory) {
        return string.concat(".cases[", vm.toString(_i), "]", _field);
    }

    function test_headerMatchesFixture() public view {
        for (uint256 i = 0; i < count; ++i) {
            string memory name = vm.parseJsonString(json, _path(i, ".name"));
            bytes memory memo = vm.parseJsonBytes(json, _path(i, ".memo"));

            MemoCodec.Header memory header = harness.readHeader(memo);

            assertEq(uint256(header.opcode), vm.parseJsonUint(json, _path(i, ".opcode")), name);
            assertEq(uint256(header.walletId), vm.parseJsonUint(json, _path(i, ".walletId")), name);
            assertEq(
                uint256(header.executorFee), vm.parseJsonUint(json, _path(i, ".executorFee")), name
            );
        }
    }

    /// @dev The core claim: TS-produced payload bytes survive a Solidity decode/encode cycle
    ///      unchanged, so the two ABI encoders agree exactly.
    function test_instructionPayloadRoundTripsInSolidity() public view {
        uint256 checked;
        for (uint256 i = 0; i < count; ++i) {
            bytes memory payload = vm.parseJsonBytes(json, _path(i, ".payload"));
            if (payload.length == 0) {
                continue;
            }
            _assertPayloadMatchesFixture(i, payload);
            ++checked;
        }
        assertGt(checked, 0, "no instruction fixtures");
    }

    /// @dev Split out: a five-way tuple decode plus the loop's locals overflows the stack.
    function _assertPayloadMatchesFixture(uint256 _i, bytes memory _payload) internal view {
        string memory name = vm.parseJsonString(json, _path(_i, ".name"));

        assertEq(harness.roundTripInstruction(_payload), _payload, name);

        (address sender, uint256 nonce, address feeToken, uint256 feeAmount, uint256 callCount) =
            harness.decodeInstruction(_payload);
        assertEq(sender, vm.parseJsonAddress(json, _path(_i, ".sender")), name);
        assertEq(nonce, vm.parseJsonUint(json, _path(_i, ".nonce")), name);
        assertEq(feeToken, vm.parseJsonAddress(json, _path(_i, ".feeToken")), name);
        assertEq(feeAmount, vm.parseJsonUint(json, _path(_i, ".feeAmount")), name);
        assertEq(callCount, vm.parseJsonUint(json, _path(_i, ".callCount")), name);

        // Pins every byte of every call, and now the fee, transitively.
        assertEq(keccak256(_payload), vm.parseJsonBytes32(json, _path(_i, ".commitment")), name);
    }

    function test_inlinePayloadEqualsRecordedPayload() public view {
        uint256 checked;
        for (uint256 i = 0; i < count; ++i) {
            bytes memory memo = vm.parseJsonBytes(json, _path(i, ".memo"));
            if (uint8(memo[0]) != MemoCodec.OP_EXEC_INLINE) {
                continue;
            }
            string memory name = vm.parseJsonString(json, _path(i, ".name"));
            assertEq(harness.inlinePayload(memo), vm.parseJsonBytes(json, _path(i, ".payload")), name);
            ++checked;
        }
        assertGt(checked, 0, "no 0xFD fixtures");
    }

    function test_commitOpcodeCarriesRecordedCommitment() public view {
        uint256 checked;
        for (uint256 i = 0; i < count; ++i) {
            bytes memory memo = vm.parseJsonBytes(json, _path(i, ".memo"));
            if (uint8(memo[0]) != MemoCodec.OP_EXEC_COMMIT) {
                continue;
            }
            string memory name = vm.parseJsonString(json, _path(i, ".name"));
            assertEq(memo.length, MemoCodec.LENGTH_WORD, name);
            assertEq(harness.commitment(memo), vm.parseJsonBytes32(json, _path(i, ".commitment")), name);
            ++checked;
        }
        assertGt(checked, 0, "no 0xFC fixtures");
    }

    function test_managementOpcodesMatchFixture() public view {
        uint256 checked;
        for (uint256 i = 0; i < count; ++i) {
            bytes memory memo = vm.parseJsonBytes(json, _path(i, ".memo"));
            uint8 op = uint8(memo[0]);
            string memory name = vm.parseJsonString(json, _path(i, ".name"));

            if (op == MemoCodec.OP_IGNORE) {
                assertEq(memo.length, MemoCodec.LENGTH_WORD, name);
                assertEq(
                    harness.ignoreTarget(memo),
                    vm.parseJsonBytes32(json, _path(i, ".targetTransactionId")),
                    name
                );
                ++checked;
            } else if (op == MemoCodec.OP_SET_NONCE) {
                assertEq(memo.length, MemoCodec.LENGTH_WORD, name);
                assertEq(harness.newNonce(memo), vm.parseJsonUint(json, _path(i, ".newNonce")), name);
                ++checked;
            } else if (op == MemoCodec.OP_REPLACE_FEE) {
                assertEq(memo.length, MemoCodec.LENGTH_WORD_FEE, name);
                (bytes32 target, uint64 newFee) = harness.replacementFee(memo);
                assertEq(target, vm.parseJsonBytes32(json, _path(i, ".targetTransactionId")), name);
                assertEq(uint256(newFee), vm.parseJsonUint(json, _path(i, ".newFee")), name);
                ++checked;
            }
        }
        assertEq(checked, 5, "expected 5 management fixtures");
    }

    // --- negative space -----------------------------------------------------------------

    function test_revertsOnMemoShorterThanHeader() public {
        bytes memory memo = hex"fd0000";
        vm.expectRevert(abi.encodeWithSelector(MemoCodec.MemoTooShort.selector, 3));
        harness.readHeader(memo);
    }

    function test_reservedBandIsExactlyF8ToFB() public view {
        for (uint256 op = 0; op <= 0xff; ++op) {
            bool expected = op >= 0xf8 && op <= 0xfb;
            assertEq(harness.isReserved(uint8(op)), expected, "reserved band");
        }
    }

    function test_revertsOnWrongFixedLength() public {
        bytes memory short = new bytes(MemoCodec.LENGTH_WORD - 1);
        short[0] = bytes1(MemoCodec.OP_EXEC_COMMIT);
        vm.expectRevert(
            abi.encodeWithSelector(
                MemoCodec.InvalidMemoLength.selector,
                MemoCodec.OP_EXEC_COMMIT,
                MemoCodec.LENGTH_WORD,
                MemoCodec.LENGTH_WORD - 1
            )
        );
        harness.commitment(short);

        bytes memory long = new bytes(MemoCodec.LENGTH_WORD_FEE + 1);
        long[0] = bytes1(MemoCodec.OP_REPLACE_FEE);
        vm.expectRevert(
            abi.encodeWithSelector(
                MemoCodec.InvalidMemoLength.selector,
                MemoCodec.OP_REPLACE_FEE,
                MemoCodec.LENGTH_WORD_FEE,
                MemoCodec.LENGTH_WORD_FEE + 1
            )
        );
        harness.replacementFee(long);
    }

    function test_revertsOnInlineWithNoPayload() public {
        bytes memory memo = new bytes(MemoCodec.HEADER_LENGTH);
        memo[0] = bytes1(MemoCodec.OP_EXEC_INLINE);
        vm.expectRevert(
            abi.encodeWithSelector(MemoCodec.MemoTooShort.selector, MemoCodec.HEADER_LENGTH)
        );
        harness.inlinePayload(memo);
    }

    // --- fuzz ---------------------------------------------------------------------------

    function testFuzz_headerDecodeIsTotalForLongEnoughMemos(
        uint8 _opcode,
        uint8 _walletId,
        uint64 _fee,
        bytes calldata _tail
    ) public view {
        bytes memory memo = abi.encodePacked(_opcode, _walletId, _fee, _tail);
        MemoCodec.Header memory header = harness.readHeader(memo);
        assertEq(uint256(header.opcode), uint256(_opcode));
        assertEq(uint256(header.walletId), uint256(_walletId));
        assertEq(uint256(header.executorFee), uint256(_fee));
    }

    struct FuzzInstruction {
        address sender;
        uint256 nonce;
        address feeToken;
        uint256 feeAmount;
        address target;
        uint256 value;
    }

    function testFuzz_instructionEncodingIsCanonical(FuzzInstruction calldata _f, bytes calldata _data)
        public
        view
    {
        IPersonalAccount.Call[] memory calls = new IPersonalAccount.Call[](1);
        calls[0] = IPersonalAccount.Call({target: _f.target, value: _f.value, data: _data});

        bytes memory payload = abi.encode(_f.sender, _f.nonce, _f.feeToken, _f.feeAmount, calls);
        assertEq(harness.roundTripInstruction(payload), payload);

        _assertDecodesTo(payload, _f);

        (address target, uint256 value, bytes memory data) = harness.callAt(payload, 0);
        assertEq(target, _f.target);
        assertEq(value, _f.value);
        assertEq(data, _data);
    }

    function _assertDecodesTo(bytes memory _payload, FuzzInstruction calldata _f) private view {
        (address sender, uint256 nonce, address feeToken, uint256 feeAmount, uint256 callCount) =
            harness.decodeInstruction(_payload);
        assertEq(sender, _f.sender);
        assertEq(nonce, _f.nonce);
        assertEq(feeToken, _f.feeToken);
        assertEq(feeAmount, _f.feeAmount);
        assertEq(callCount, 1);
    }
}
