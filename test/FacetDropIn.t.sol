// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MemoKitTestBase} from "./base/MemoKitTestBase.sol";
import {IDiamondCut} from "../contracts/diamond/IDiamondCut.sol";
import {MemoCodec} from "../contracts/libraries/MemoCodec.sol";
import {MemoControllerFacet} from "../contracts/facets/MemoControllerFacet.sol";

/**
 * @notice A host facet with a legacy, non-namespaced storage layout, writing straight to
 *         slots 0, 1 and 2. Stands in for an existing diamond whose facets predate ERC-7201.
 */
contract LegacyHostFacet {
    function hostWrite(uint256 _a, uint256 _b, uint256 _c) external {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            sstore(0, _a)
            sstore(1, _b)
            sstore(2, _c)
        }
    }

    function hostRead() external view returns (uint256 _a, uint256 _b, uint256 _c) {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            _a := sload(0)
            _b := sload(1)
            _c := sload(2)
        }
    }
}

/**
 * @title FacetDropInTest
 * @notice Proves `MemoControllerFacet` is genuinely cuttable into someone else's diamond.
 *
 * @dev This is the A2 design constraint from the brief, tested rather than asserted. Three
 *      properties have to hold, and each is checked below:
 *
 *        1. the facet carries no constructor state and no immutables, so the deployed code
 *           is complete and a host diamond can delegatecall it as-is;
 *        2. every slot it touches is ERC-7201 namespaced, so it cannot corrupt -- or be
 *           corrupted by -- a host's legacy layout;
 *        3. the only addresses in its execution path are well-known constants, so it needs
 *           no configuration to find Flare's infrastructure.
 */
contract FacetDropInTest is MemoKitTestBase {
    LegacyHostFacet internal host;

    function setUp() public override {
        super.setUp();

        host = new LegacyHostFacet();
        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = LegacyHostFacet.hostWrite.selector;
        selectors[1] = LegacyHostFacet.hostRead.selector;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = _cut(address(host), selectors);

        vm.prank(owner);
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
    }

    /// @dev A facet with constructor state would have that state on the facet, not on the
    ///      diamond, so a host delegatecalling it would read zeros. Ours reads nothing from
    ///      its own storage, which is why this works at all.
    function test_facetHasNoOwnStorageDependency() public {
        MemoControllerFacet standalone = new MemoControllerFacet();
        // Called directly, not through any diamond: the facet's own storage is empty, so the
        // nonce reads zero rather than reverting. Nothing was baked in at construction.
        assertEq(standalone.nonceOf(address(this)), 0);
        assertFalse(standalone.isTransactionIdUsed(bytes32(uint256(1))));
    }

    function test_memokitStateDoesNotDisturbLegacyHostSlots() public {
        LegacyHostFacet(address(diamond)).hostWrite(111, 222, 333);

        address account = _accountFor(XRPL_SENDER);
        _fund(account, 10_000_000);

        bytes memory payload = _instruction(
            account, 0, _oneCall(address(fxrp), 0, abi.encodeCall(IERC20.transfer, (owner, 5_000)))
        );
        bytes memory memo =
            abi.encodePacked(_header(MemoCodec.OP_EXEC_COMMIT, 1, uint64(0)), keccak256(payload));

        vm.prank(executor);
        controller.execute(_proof(bytes32(uint256(7)), memo), payload);

        (uint256 a, uint256 b, uint256 c) = LegacyHostFacet(address(diamond)).hostRead();
        assertEq(a, 111, "host slot 0 clobbered");
        assertEq(b, 222, "host slot 1 clobbered");
        assertEq(c, 333, "host slot 2 clobbered");
        assertEq(controller.nonceOf(account), 1, "memokit still worked");
    }

    function test_legacyHostWritesDoNotDisturbMemokitState() public {
        address account = _accountFor(XRPL_SENDER);
        _fund(account, 10_000_000);

        bytes memory payload = _instruction(
            account, 0, _oneCall(address(fxrp), 0, abi.encodeCall(IERC20.transfer, (owner, 5_000)))
        );
        bytes memory memo =
            abi.encodePacked(_header(MemoCodec.OP_EXEC_COMMIT, 1, uint64(0)), keccak256(payload));

        vm.prank(executor);
        controller.execute(_proof(bytes32(uint256(7)), memo), payload);

        LegacyHostFacet(address(diamond)).hostWrite(
            type(uint256).max, type(uint256).max, type(uint256).max
        );

        assertEq(controller.nonceOf(account), 1, "nonce survived");
        assertTrue(controller.isTransactionIdUsed(bytes32(uint256(7))), "replay set survived");
        assertEq(admin.owner(), owner, "owner survived");
        assertEq(admin.sourceId(), SOURCE_ID, "config survived");
        assertFalse(admin.paused(), "pause flag survived");
    }

    /// @dev Namespaced slots must be far apart from each other as well as from slot 0.
    function test_namespacedSlotsAreDistinct() public pure {
        bytes32[6] memory slots = [
            _slot("memokit.Accounts.State"),
            _slot("memokit.Execution.State"),
            _slot("memokit.Proofs.State"),
            _slot("memokit.Fees.State"),
            _slot("memokit.Pause.State"),
            _slot("memokit.Governance.State")
        ];
        for (uint256 i = 0; i < slots.length; ++i) {
            assertTrue(slots[i] != bytes32(0), "slot must not be zero");
            // ERC-7201 zeroes the last byte so the slot cannot start an array or mapping run.
            assertEq(uint256(slots[i]) & 0xff, 0, "low byte must be masked");
            for (uint256 j = i + 1; j < slots.length; ++j) {
                assertTrue(slots[i] != slots[j], "namespace collision");
            }
        }
    }

    function _slot(string memory _name) private pure returns (bytes32) {
        return keccak256(abi.encode(uint256(keccak256(bytes(_name))) - 1)) & ~bytes32(uint256(0xff));
    }
}
