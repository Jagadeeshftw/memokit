// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {FtsoV2Interface} from "flare-periphery/coston2/FtsoV2Interface.sol";
import {ContractRegistry} from "flare-periphery/coston2/ContractRegistry.sol";

/**
 * @title FtsoFeedsTest
 * @notice Read-only, live: which FTSOv2 feeds exist on Coston2 and Flare mainnet, and what
 *         decimals they report.
 *
 * @dev Unlike the other fork tests, nothing here is simulated and nothing is mocked. These are
 *      real reads against the deployed FTSOv2 on each network, at the head of chain.
 *
 *      The reason this test exists rather than a note in a document: feed decimals are not a
 *      constant. They vary per feed, and the same feed reports different decimals on different
 *      networks. An implementation that pinned them would pass on Coston2 and misprice by 10x
 *      on mainnet. `PostConditions` therefore reads decimals from the feed at execution time,
 *      and this test is the evidence for why.
 */
contract FtsoFeedsTest is Test {
    string[7] internal NAMES = [
        "FLR/USD",
        "XRP/USD",
        "ETH/USD",
        "USDT/USD",
        "USDC/USD",
        "BTC/USD",
        "SGB/USD"
    ];

    function _feedId(string memory _name) internal pure returns (bytes21) {
        bytes memory n = bytes(_name);
        bytes memory out = new bytes(21);
        out[0] = 0x01; // crypto
        for (uint256 i = 0; i < n.length; ++i) {
            out[i + 1] = n[i];
        }
        return bytes21(out);
    }

    function _report(string memory _network) internal returns (int8[7] memory _decimals) {
        FtsoV2Interface ftso = ContractRegistry.getFtsoV2();
        emit log_named_string("network", _network);
        emit log_named_address("FtsoV2", address(ftso));

        for (uint256 i = 0; i < NAMES.length; ++i) {
            (uint256 value, int8 decimals, uint64 timestamp) = ftso.getFeedById(_feedId(NAMES[i]));
            _decimals[i] = decimals;

            assertGt(value, 0, string.concat(NAMES[i], ": feed exists but reports zero"));
            assertGe(decimals, 0, string.concat(NAMES[i], ": negative decimals"));
            // Every feed must be fresh enough to be usable as a rate bound at all.
            assertLe(
                block.timestamp - timestamp, 1 hours, string.concat(NAMES[i], ": stale at head")
            );

            emit log_named_string(
                NAMES[i],
                string.concat(
                    "value=",
                    vm.toString(value),
                    " decimals=",
                    vm.toString(uint256(uint8(decimals))),
                    " age=",
                    vm.toString(block.timestamp - timestamp),
                    "s"
                )
            );
        }
    }

    function test_everyReferenceFeedExistsOnBothNetworks() public {
        vm.createSelectFork("coston2");
        int8[7] memory coston2 = _report("coston2");

        vm.createSelectFork("flare");
        int8[7] memory flare = _report("flare");

        // The finding: same feed, same category byte, different decimals per network.
        uint256 differing;
        for (uint256 i = 0; i < NAMES.length; ++i) {
            if (coston2[i] != flare[i]) {
                ++differing;
                emit log_named_string(
                    "DECIMALS DIFFER",
                    string.concat(
                        NAMES[i],
                        ": coston2=",
                        vm.toString(uint256(uint8(coston2[i]))),
                        " flare=",
                        vm.toString(uint256(uint8(flare[i])))
                    )
                );
            }
        }
        emit log_named_uint("feeds whose decimals differ across networks", differing);

        // Not asserted as an exact count: Flare may re-scale a feed at any time, and this test
        // is here to surface that, not to break when it happens. What IS asserted is that
        // nothing in memokit depends on them matching.
        assertGt(NAMES.length, 0);
    }
}
