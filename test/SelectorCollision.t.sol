// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

import {FacetSelectors} from "../scripts/lib/FacetSelectors.sol";
import {MemoControllerFacet} from "../contracts/facets/MemoControllerFacet.sol";
import {AccountsFacet} from "../contracts/facets/AccountsFacet.sol";
import {AdminFacet} from "../contracts/facets/AdminFacet.sol";
import {DiamondLoupeFacet} from "../contracts/diamond/DiamondLoupeFacet.sol";
import {DiamondCutFacet} from "../contracts/diamond/DiamondCutFacet.sol";

/**
 * @title SelectorCollisionTest
 * @notice memokit's external selectors, diffed against the live Flare `MasterAccountController`.
 *
 * @dev The bug class. A selector memokit shares with Flare's diamond is invisible to the
 *      compiler and to every other test here. It surfaces as a reverted `diamondCut` at best,
 *      and at worst as callers silently reaching *Flare's* implementation and reading *Flare's*
 *      state as if it were memokit's -- a confident wrong answer, not an error. Phase 1 found
 *      two (`implementation()`, `isTransactionIdUsed(bytes32)`) by diffing by hand, once. That
 *      is an instance; this test closes the class.
 *
 *      How it stays honest:
 *
 *        - memokit's side is read from the compiled artifacts (`methodIdentifiers`), not from
 *          `FacetSelectors`. A function added to a facet is checked whether or not anyone
 *          remembered to list it. A second test asserts the deploy cut lists every one of them,
 *          which also closes the reverse hole (works in tests, `FunctionNotFound` on chain).
 *        - Flare's side is `fixtures/flare-selectors/{coston2,flare}.json`: the loupe output at a
 *          pinned block on each network, written by `npm run selectors:refresh`. Both networks
 *          are checked, because they differ (74 selectors on Coston2, 59 on mainnet).
 *        - Overlap is the failure. The drop-in unit (`MemoControllerFacet`, `AccountsFacet`) must
 *          have none, ever. The remaining surfaces overlap for reasons that are structural, not
 *          accidental, and each is listed below with its reason. The list is *exact*: an overlap
 *          that is not on it fails, and an entry that no longer overlaps also fails, so it
 *          cannot rot into a blanket exemption.
 *
 *      What this cannot tell you. The fixtures are a snapshot. Flare's diamond is upgradeable, so
 *      a green run proves memokit does not collide with Flare *as of the pinned blocks*.
 *      `npm run selectors:check` re-reads the chain and fails on drift.
 */
contract SelectorCollisionTest is Test {
    string internal constant COSTON2 = "fixtures/flare-selectors/coston2.json";
    string internal constant FLARE = "fixtures/flare-selectors/flare.json";

    /// @dev One memokit contract, as the compiler sees it.
    struct Surface {
        string label;
        string artifact;
        string[] exemptions; // signatures allowed to overlap Flare's, each justified in `_surfaces`
    }

    // --- the tests -----------------------------------------------------------------------

    function test_dropInUnitNeverOverlapsFlare() public {
        _assertNoOverlapWithFlare(COSTON2, "MemoControllerFacet", _artifact("MemoControllerFacet"));
        _assertNoOverlapWithFlare(FLARE, "MemoControllerFacet", _artifact("MemoControllerFacet"));
        _assertNoOverlapWithFlare(COSTON2, "AccountsFacet", _artifact("AccountsFacet"));
        _assertNoOverlapWithFlare(FLARE, "AccountsFacet", _artifact("AccountsFacet"));
    }

    function test_everyOverlapIsExplainedAndNoExplanationIsStale() public {
        Surface[] memory surfaces = _surfaces();
        string memory report;
        for (uint256 s = 0; s < surfaces.length; ++s) {
            bytes4[] memory exempt = _selectorsOf(surfaces[s].exemptions);
            bool[] memory used = new bool[](exempt.length);

            report = string.concat(report, _checkNetwork(COSTON2, "coston2", surfaces[s], exempt, used));
            report = string.concat(report, _checkNetwork(FLARE, "flare", surfaces[s], exempt, used));

            for (uint256 i = 0; i < exempt.length; ++i) {
                if (!used[i]) {
                    report = string.concat(
                        report, "\n  STALE EXEMPTION ", surfaces[s].label, " ", surfaces[s].exemptions[i]
                    );
                }
            }
        }
        if (bytes(report).length != 0) {
            fail(
                string.concat(
                    "memokit selectors also routed by Flare's MasterAccountController (cutting memokit in "
                    "would revert, or shadow Flare's function), or exemptions that no longer apply:",
                    report
                )
            );
        }
    }

    /// @dev Reverse hole: the selector-collision check reads artifacts, but a deployment only
    ///      routes what `FacetSelectors` lists. If they disagree, a function the tests exercise
    ///      through the facet is unreachable on chain.
    function test_deployCutRoutesEveryExternalFunctionOfEveryFacet() public {
        _assertCutMatchesArtifact("MemoControllerFacet", FacetSelectors.controller());
        _assertCutMatchesArtifact("AccountsFacet", FacetSelectors.accounts());
        _assertCutMatchesArtifact("AdminFacet", FacetSelectors.admin());
        _assertCutMatchesArtifact("DiamondLoupeFacet", FacetSelectors.loupe());
    }

    /// @dev The fixtures are load-bearing; a truncated or mislabelled one would turn every
    ///      assertion above into a vacuous pass.
    function test_fixturesAreTheSizeChainReportedAndCarryBothNetworks() public {
        _assertFixture(COSTON2, "coston2", 114, 74);
        _assertFixture(FLARE, "flare", 14, 59);
    }

    /// @dev Proves the diff can go red. Compares a memokit surface against a fixture that is
    ///      known to contain one of its selectors and asserts the overlap is reported.
    function test_theDiffDetectsAPlantedCollision() public {
        // Flare's controller has `owner()`; memokit's AdminFacet also has `owner()`.
        bytes4[] memory overlap = _overlap(_artifact("AdminFacet"), _flareSelectors(COSTON2));
        bool found;
        for (uint256 i = 0; i < overlap.length; ++i) {
            if (overlap[i] == AdminFacet.owner.selector) found = true;
        }
        assertTrue(found, "detector missed a collision that is known to exist");
    }

    // --- what is allowed to overlap, and why ---------------------------------------------

    function _surfaces() internal pure returns (Surface[] memory s) {
        s = new Surface[](8);

        // The drop-in unit. Zero exemptions, forever.
        s[0] = Surface("MemoControllerFacet", "MemoControllerFacet", new string[](0));
        s[1] = Surface("AccountsFacet", "AccountsFacet", new string[](0));

        // Governance duplicated by a host. Inherent, and documented in PHASE1.md section 5c: a host
        // diamond has its own owner and pause and would drive memokit's namespaced config through
        // them, so AdminFacet is not part of the drop-in unit.
        //
        // Phase 1 recorded three of these (owner, pause, unpause) from a hand diff. The mechanical
        // diff found six; isPauser, isUnpauser and transferOwnership had been missed. All six sit
        // in one facet that was already outside the unit, which is why the miss was harmless, but
        // it is the argument for not diffing by hand.
        string[] memory admin = new string[](6);
        admin[0] = "owner()";
        admin[1] = "transferOwnership(address)";
        admin[2] = "pause()";
        admin[3] = "unpause()";
        admin[4] = "isPauser(address)";
        admin[5] = "isUnpauser(address)";
        s[2] = Surface("AdminFacet", "AdminFacet", admin);

        // EIP-2535 requires exactly these. Any two conforming diamonds overlap here.
        string[] memory loupe = new string[](4);
        loupe[0] = "facets()";
        loupe[1] = "facetFunctionSelectors(address)";
        loupe[2] = "facetAddresses()";
        loupe[3] = "facetAddress(bytes4)";
        s[3] = Surface("DiamondLoupeFacet", "DiamondLoupeFacet", loupe);

        string[] memory cut = new string[](1);
        cut[0] = "diamondCut((address,uint8,bytes4[])[],address,bytes)";
        s[4] = Surface("DiamondCutFacet", "DiamondCutFacet", cut);

        // IBeacon fixes this signature; the proxy calls it by that name. Flare's controller is its
        // own beacon, so it has it. memokit's beacon is a separate contract that is never cut into
        // Flare's diamond, so the overlap is harmless -- and is the reason it is separate.
        string[] memory beacon = new string[](1);
        beacon[0] = "implementation()";
        s[5] = Surface("PersonalAccountBeacon", "PersonalAccountBeacon", beacon);

        // Account: a separate contract behind a beacon proxy, never cut into any diamond, so the
        // only overlap it can have is a standard interface. ERC-165 `supportsInterface(bytes4)` is
        // one: Flare's diamond answers it too, and both mean "what does *this* contract implement".
        string[] memory account = new string[](1);
        account[0] = "supportsInterface(bytes4)";
        s[6] = Surface("PersonalAccount", "PersonalAccount", account);
        s[7] = Surface("PersonalAccountProxy", "PersonalAccountProxy", new string[](0));
    }

    // --- machinery ------------------------------------------------------------------------

    /// @dev Returns a report line per unexplained overlap rather than failing on the first, so
    ///      one run lists every collision.
    function _checkNetwork(
        string memory _fixture,
        string memory _network,
        Surface memory _surface,
        bytes4[] memory _exempt,
        bool[] memory _used
    ) internal view returns (string memory _report) {
        bytes4[] memory overlap = _overlap(_artifact(_surface.artifact), _flareSelectors(_fixture));
        for (uint256 i = 0; i < overlap.length; ++i) {
            (bool allowed, uint256 at) = _indexOf(_exempt, overlap[i]);
            if (allowed) {
                _used[at] = true;
            } else {
                _report = string.concat(
                    _report,
                    "\n  ",
                    _network,
                    ": ",
                    _surface.label,
                    " ",
                    _hex4(overlap[i]),
                    " (",
                    _signatureOf(_surface.artifact, overlap[i]),
                    ")"
                );
            }
        }
    }

    function _hex4(bytes4 _s) internal pure returns (string memory) {
        return vm.toString(abi.encodePacked(_s));
    }

    /// @dev Human name for a selector, from the same artifact it was read from.
    function _signatureOf(string memory _contract, bytes4 _selector) internal view returns (string memory) {
        string memory json = vm.readFile(string.concat("out/", _contract, ".sol/", _contract, ".json"));
        string[] memory signatures = vm.parseJsonKeys(json, ".methodIdentifiers");
        for (uint256 i = 0; i < signatures.length; ++i) {
            if (bytes4(keccak256(bytes(signatures[i]))) == _selector) return signatures[i];
        }
        return "?";
    }

    function _assertNoOverlapWithFlare(string memory _fixture, string memory _label, bytes4[] memory _memokit)
        internal
    {
        bytes4[] memory overlap = _overlap(_memokit, _flareSelectors(_fixture));
        assertEq(overlap.length, 0, string.concat(_label, " overlaps Flare in ", _fixture));
    }

    function _assertCutMatchesArtifact(string memory _facet, bytes4[] memory _cut) internal {
        bytes4[] memory built = _artifact(_facet);
        assertEq(_cut.length, built.length, string.concat(_facet, ": cut and artifact disagree on count"));
        for (uint256 i = 0; i < built.length; ++i) {
            (bool routed,) = _indexOf(_cut, built[i]);
            assertTrue(routed, string.concat(_facet, ": an external function is not in FacetSelectors"));
        }
    }

    function _assertFixture(string memory _path, string memory _network, uint256 _chainId, uint256 _count)
        internal
    {
        string memory json = vm.readFile(_path);
        assertEq(vm.parseJsonString(json, ".network"), _network, "network label");
        assertEq(vm.parseJsonUint(json, ".chainId"), _chainId, "chain id");
        assertEq(_flareSelectors(_path).length, _count, string.concat(_network, ": selector count"));
        assertEq(vm.parseJsonUint(json, ".selectorCount"), _count, string.concat(_network, ": recorded count"));
        assertGt(vm.parseJsonUint(json, ".blockNumber"), 0, "fixture must record its block");
    }

    /// @dev memokit's external selectors, straight from the compiler: every key of the
    ///      artifact's `methodIdentifiers`, which includes inherited external functions.
    function _artifact(string memory _contract) internal view returns (bytes4[] memory _out) {
        string memory json =
            vm.readFile(string.concat("out/", _contract, ".sol/", _contract, ".json"));
        string[] memory signatures = vm.parseJsonKeys(json, ".methodIdentifiers");
        _out = new bytes4[](signatures.length);
        for (uint256 i = 0; i < signatures.length; ++i) {
            string memory hexSelector =
                vm.parseJsonString(json, string.concat('.methodIdentifiers["', signatures[i], '"]'));
            _out[i] = bytes4(vm.parseBytes(string.concat("0x", hexSelector)));
        }
    }

    function _flareSelectors(string memory _fixture) internal view returns (bytes4[] memory _out) {
        string[] memory raw = vm.parseJsonStringArray(vm.readFile(_fixture), ".selectors");
        _out = new bytes4[](raw.length);
        for (uint256 i = 0; i < raw.length; ++i) {
            _out[i] = bytes4(vm.parseBytes(raw[i]));
        }
    }

    function _selectorsOf(string[] memory _signatures) internal pure returns (bytes4[] memory _out) {
        _out = new bytes4[](_signatures.length);
        for (uint256 i = 0; i < _signatures.length; ++i) {
            _out[i] = bytes4(keccak256(bytes(_signatures[i])));
        }
    }

    function _overlap(bytes4[] memory _a, bytes4[] memory _b) internal pure returns (bytes4[] memory _out) {
        bytes4[] memory tmp = new bytes4[](_a.length);
        uint256 n;
        for (uint256 i = 0; i < _a.length; ++i) {
            (bool hit,) = _indexOf(_b, _a[i]);
            if (hit) tmp[n++] = _a[i];
        }
        _out = new bytes4[](n);
        for (uint256 i = 0; i < n; ++i) {
            _out[i] = tmp[i];
        }
    }

    function _indexOf(bytes4[] memory _set, bytes4 _x) internal pure returns (bool, uint256) {
        for (uint256 i = 0; i < _set.length; ++i) {
            if (_set[i] == _x) return (true, i);
        }
        return (false, 0);
    }
}
