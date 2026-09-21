// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ContractRegistry} from "flare-periphery/coston2/ContractRegistry.sol";
import {FtsoV2Interface} from "flare-periphery/coston2/FtsoV2Interface.sol";
import {IPostConditions} from "../interfaces/IPostConditions.sol";

/**
 * @title PostConditions
 * @notice Snapshot-then-check evaluation of an instruction's post-conditions.
 *
 * @dev Two passes. {snapshot} runs before the calls and records the balances any delta
 *      condition will measure against; {check} runs after them and asserts every condition.
 *      A failure reverts, which unwinds the calls, the nonce, and the replay mark with it —
 *      see the note on failure semantics in PHASE3.md.
 *
 *      Conditions are evaluated in payload order and the first failure names its own index, so
 *      a caller can tell which claim was not met without re-simulating.
 */
library PostConditions {
    using Math for uint256;

    /// @notice Upper bound on conditions per instruction.
    /// @dev Each delta condition costs an external balance read before *and* after the calls,
    ///      and each FTSO condition costs two non-view feed reads. The cap keeps a single
    ///      instruction from becoming unexecutably expensive; 32 is far above any real payout.
    uint256 internal constant MAX_POST_CONDITIONS = 32;

    uint256 private constant BPS = 10_000;

    /**
     * @notice Record the balances that delta conditions will be measured against.
     * @dev Returns a parallel array; entries for non-delta kinds are zero and unused.
     */
    function snapshot(IPostConditions.PostCondition[] memory _conditions)
        internal
        view
        returns (uint256[] memory _before)
    {
        uint256 count = _conditions.length;
        require(
            count <= MAX_POST_CONDITIONS,
            IPostConditions.TooManyPostConditions(count, MAX_POST_CONDITIONS)
        );

        _before = new uint256[](count);
        for (uint256 i = 0; i < count; ++i) {
            IPostConditions.PostCondition memory c = _conditions[i];
            if (c.kind == IPostConditions.Kind.Erc20DeltaAtLeast) {
                _requireToken(i, c);
                _before[i] = IERC20(c.token).balanceOf(c.subject);
            } else if (c.kind == IPostConditions.Kind.NativeDeltaAtLeast) {
                _requireNative(i, c);
                _before[i] = c.subject.balance;
            } else if (c.kind == IPostConditions.Kind.FtsoRateAtLeast) {
                _requireToken(i, c);
                // The realised output is a delta, so it needs a pre-reading too.
                _before[i] = IERC20(c.token).balanceOf(c.subject);
            } else if (c.kind == IPostConditions.Kind.Erc20BalanceAtLeast) {
                _requireToken(i, c);
            } else {
                _requireNative(i, c);
            }
        }
    }

    /**
     * @notice Assert every condition. Reverts on the first failure.
     * @param _conditions The conditions, exactly as the payload committed to them.
     * @param _before The array {snapshot} returned for the same conditions.
     * @dev Not `view`: FTSOv2's `getFeedById` is declared `payable`, so a rate condition cannot
     *      be evaluated from a static context. Conditions without a rate bound are pure reads.
     */
    function check(IPostConditions.PostCondition[] memory _conditions, uint256[] memory _before)
        internal
    {
        for (uint256 i = 0; i < _conditions.length; ++i) {
            IPostConditions.PostCondition memory c = _conditions[i];

            if (c.kind == IPostConditions.Kind.Erc20BalanceAtLeast) {
                uint256 actual = IERC20(c.token).balanceOf(c.subject);
                _requireAtLeast(i, c.kind, c.threshold, actual);
            } else if (c.kind == IPostConditions.Kind.Erc20DeltaAtLeast) {
                uint256 actual = IERC20(c.token).balanceOf(c.subject);
                _requireAtLeast(i, c.kind, c.threshold, _delta(_before[i], actual));
            } else if (c.kind == IPostConditions.Kind.NativeBalanceAtLeast) {
                _requireAtLeast(i, c.kind, c.threshold, c.subject.balance);
            } else if (c.kind == IPostConditions.Kind.NativeDeltaAtLeast) {
                _requireAtLeast(i, c.kind, c.threshold, _delta(_before[i], c.subject.balance));
            } else {
                _checkFtsoRate(i, c, _before[i]);
            }
        }
    }

    /// @dev A balance that fell gives a delta of zero rather than underflowing, so the failure
    ///      is reported as "wanted X, got 0" instead of a panic.
    function _delta(uint256 _before_, uint256 _after) private pure returns (uint256) {
        return _after > _before_ ? _after - _before_ : 0;
    }

    function _requireAtLeast(
        uint256 _index,
        IPostConditions.Kind _kind,
        uint256 _required,
        uint256 _actual
    ) private pure {
        require(
            _actual >= _required,
            IPostConditions.PostConditionFailed(_index, _kind, _required, _actual)
        );
    }

    function _requireToken(uint256 _i, IPostConditions.PostCondition memory _c) private pure {
        require(_c.token != address(0), IPostConditions.MalformedPostCondition(_i, _c.kind));
    }

    function _requireNative(uint256 _i, IPostConditions.PostCondition memory _c) private pure {
        require(_c.token == address(0), IPostConditions.MalformedPostCondition(_i, _c.kind));
        require(_c.extra.length == 0, IPostConditions.MalformedPostCondition(_i, _c.kind));
    }

    /**
     * @notice Bound a realised swap rate against FTSOv2.
     *
     * @dev What this protects against, and what it does not.
     *
     *      It protects against the pool being in a bad state at the moment of execution:
     *      manipulation, a sandwich, a stale or thin pool. Those move the pool price away from
     *      the wider market, and the oracle is the wider market.
     *
     *      It does NOT protect against the market itself moving during the ~150 s an attestation
     *      takes. If XRP genuinely falls 3% in those 150 s, the oracle falls with it and the fill
     *      is judged against the new rate. That exposure is inherent to committing to a trade
     *      before it settles, and the user accepts it by signing. The absolute
     *      `Erc20DeltaAtLeast` floor is what caps *that* risk, which is why both exist and why
     *      neither replaces the other.
     */
    function _checkFtsoRate(
        uint256 _index,
        IPostConditions.PostCondition memory _c,
        uint256 _outBefore
    ) private {
        IPostConditions.FtsoBound memory b = abi.decode(_c.extra, (IPostConditions.FtsoBound));

        uint256 realisedOut = _delta(_outBefore, IERC20(_c.token).balanceOf(_c.subject));

        (uint256 priceIn, uint8 decIn) = _readFeed(_index, b.feedIdIn, b.maxFeedAgeSeconds);
        (uint256 priceOut, uint8 decOut) = _readFeed(_index, b.feedIdOut, b.maxFeedAgeSeconds);

        // fairOut = amountIn * (priceIn / 10^decIn) / (priceOut / 10^decOut)
        //                    * 10^tokenDecimalsOut / 10^tokenDecimalsIn
        //
        // Grouped so every division happens once, at the end, via mulDiv.
        uint256 numerator = 10 ** (uint256(decOut) + uint256(b.decimalsOut));
        uint256 denominator = 10 ** (uint256(decIn) + uint256(b.decimalsIn));
        uint256 fairOut = Math.mulDiv(
            Math.mulDiv(b.amountIn, priceIn, denominator), numerator, priceOut
        );

        uint256 requiredOut = Math.mulDiv(fairOut, BPS - b.maxDeviationBps, BPS);
        require(
            realisedOut >= requiredOut,
            IPostConditions.RateBelowOracleBound(_index, requiredOut, realisedOut)
        );
    }

    function _readFeed(uint256 _index, bytes21 _feedId, uint64 _maxAge)
        private
        returns (uint256 _price, uint8 _decimals)
    {
        FtsoV2Interface ftso = ContractRegistry.getFtsoV2();
        (uint256 value, int8 decimals, uint64 timestamp) = ftso.getFeedById(_feedId);

        require(value > 0, IPostConditions.FeedPriceZero(_index, _feedId));
        require(
            decimals >= 0, IPostConditions.FeedDecimalsNegative(_index, _feedId, decimals)
        );
        require(
            block.timestamp <= uint256(timestamp) + uint256(_maxAge),
            IPostConditions.FeedTooOld(_index, _feedId, timestamp, _maxAge)
        );
        return (value, uint8(decimals));
    }
}
