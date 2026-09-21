// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MemoKitTestBase} from "./base/MemoKitTestBase.sol";
import {PersonalAccountProxy} from "../contracts/accounts/PersonalAccountProxy.sol";
import {IPersonalAccount} from "../contracts/interfaces/IPersonalAccount.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MemoCodec} from "../contracts/libraries/MemoCodec.sol";

/**
 * @title AccountDerivationTest
 * @notice Pins the CREATE2 inputs that decide every account address.
 *
 * @dev Flare froze their proxy creation code as a hex literal because CBOR metadata made it
 *      drift on unrelated edits. memokit builds with `bytecode_hash = "none"`, which removes
 *      that failure mode, and pins the hash here so a real change to the proxy is loud.
 *
 *      If `test_proxyCreationCodeHashIsPinned` fails, every account address that has been
 *      predicted but not yet deployed has moved. That is either a deliberate decision made
 *      before any deployment, or a bug. It is never a fixture to update casually.
 */
contract AccountDerivationTest is MemoKitTestBase {
    /// @dev solc 0.8.30, cancun, optimizer on / 200 runs, bytecode_hash = none.
    bytes32 internal constant PINNED_PROXY_CODE_HASH =
        0x59953ab402ba5b2b9267d7273cd5a416e2a1caa5c273bff368d8a5d0360c4dd1;

    function test_proxyCreationCodeHashIsPinned() public view {
        bytes32 actual = keccak256(type(PersonalAccountProxy).creationCode);
        assertEq(accounts.accountProxyCodeHash(), actual, "facet and test disagree");
        assertEq(actual, PINNED_PROXY_CODE_HASH, "proxy creation code changed");
    }

    function test_computedAddressMatchesDeployedAddress() public {
        address predicted = accounts.computeAccountAddress(XRPL_SENDER);
        assertEq(predicted.code.length, 0, "not deployed yet");

        _fund(predicted, 10_000);
        bytes memory payload = _instruction(
            predicted, 0, _oneCall(address(fxrp), 0, abi.encodeCall(IERC20.transfer, (owner, 1)))
        );
        bytes memory memo =
            abi.encodePacked(_header(MemoCodec.OP_EXEC_COMMIT, 1, uint64(0)), keccak256(payload));

        controller.execute(_proof(bytes32(uint256(1)), memo), payload);

        assertGt(predicted.code.length, 0, "deployed at the predicted address");
        assertEq(accounts.accountOf(XRPL_SENDER), predicted);
    }

    function test_differentXrplOwnersGetDifferentAccounts() public view {
        address a = accounts.computeAccountAddress(XRPL_SENDER);
        address b = accounts.computeAccountAddress("rDifferentSenderXXXXXXXXXXXXXXXXXXX");
        assertTrue(a != b, "distinct owners must not collide");
    }

    /// @dev One character of difference must produce a different account.
    function test_derivationIsSensitiveToTheWholeOwnerString() public view {
        address a = accounts.computeAccountAddress("rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe");
        address b = accounts.computeAccountAddress("rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYf");
        assertTrue(a != b);
    }

    /// @dev The account address does not depend on chain id, so a given XRPL owner maps to
    ///      the same address on every chain memokit is deployed to with the same controller.
    function test_derivationIsChainIndependent() public {
        address before = accounts.computeAccountAddress(XRPL_SENDER);
        vm.chainId(14);
        assertEq(accounts.computeAccountAddress(XRPL_SENDER), before, "chain id must not matter");
        vm.chainId(114);
        assertEq(accounts.computeAccountAddress(XRPL_SENDER), before);
    }

    function test_accountRecordsItsOwnerAndController() public {
        address predicted = accounts.computeAccountAddress(XRPL_SENDER);
        _fund(predicted, 10_000);
        bytes memory payload = _instruction(
            predicted, 0, _oneCall(address(fxrp), 0, abi.encodeCall(IERC20.transfer, (owner, 1)))
        );
        bytes memory memo =
            abi.encodePacked(_header(MemoCodec.OP_EXEC_COMMIT, 1, uint64(0)), keccak256(payload));
        controller.execute(_proof(bytes32(uint256(1)), memo), payload);

        assertEq(IPersonalAccount(predicted).xrplOwner(), XRPL_SENDER);
        assertEq(IPersonalAccount(predicted).controller(), address(diamond));
    }
}
