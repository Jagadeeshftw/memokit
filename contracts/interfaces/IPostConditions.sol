// SPDX-License-Identifier: MIT
pragma solidity >=0.8.4 <0.9;

/**
 * @title IPostConditions
 * @notice Assertions evaluated after an instruction's calls, before the executor is paid.
 *
 * @dev Phase 2's Kinetic fork test found the reason these exist. Compound-family markets report
 *      most failures as a *nonzero return value*, not a revert: an oversized borrow returns code
 *      3 and the call looks successful. Without an assertion the instruction is consumed, the
 *      nonce advances, the collateral is deposited and nothing is borrowed — the user's XRPL
 *      payment spent on a no-op. Phase 2 worked around that with a hand-rolled trailing
 *      self-transfer. That is a trick, it costs a call, and it only expresses one shape of claim.
 *
 *      A post-condition says what the instruction was *for*, separately from how it was done.
 *      Every one of them is inside the committed payload, so an executor can neither remove nor
 *      weaken them.
 */
interface IPostConditions {
    /// @notice What a post-condition asserts.
    enum Kind {
        /// @notice `token.balanceOf(subject) >= threshold`.
        Erc20BalanceAtLeast,
        /// @notice `token.balanceOf(subject)` rose by at least `threshold`.
        Erc20DeltaAtLeast,
        /// @notice `subject.balance >= threshold`.
        NativeBalanceAtLeast,
        /// @notice `subject.balance` rose by at least `threshold`.
        NativeDeltaAtLeast,
        /// @notice The realised rate of a swap is within `maxDeviationBps` of FTSOv2's.
        FtsoRateAtLeast
    }

    /**
     * @notice One assertion.
     * @param kind Which assertion to make.
     * @param token ERC-20 for the `Erc20*` kinds and the *output* token for `FtsoRateAtLeast`.
     *              Must be the zero address for the native kinds.
     * @param subject Whose balance is measured. Any address, not just the account: a payout
     *                asserts that each recipient was paid.
     * @param threshold Absolute floor, or minimum delta, in the token's base units. Unused by
     *                  `FtsoRateAtLeast`, which derives its floor from the oracle.
     * @param extra ABI-encoded {FtsoBound} for `FtsoRateAtLeast`; empty for every other kind.
     */
    struct PostCondition {
        Kind kind;
        address token;
        address subject;
        uint256 threshold;
        bytes extra;
    }

    /**
     * @notice Parameters for {Kind.FtsoRateAtLeast}.
     *
     * @dev Bounds the *realised* rate of a swap against FTSOv2 at execution time. The realised
     *      output is the delta of `PostCondition.token` on `PostCondition.subject`; the input is
     *      `amountIn`, which the payload commits to.
     *
     *      One-sided on purpose. The check is "the account received at least the oracle rate
     *      minus `maxDeviationBps`". A fill *better* than the oracle is not a problem for the
     *      user, and rejecting one would be perverse.
     *
     *      Token decimals are carried explicitly because they differ across the assets involved
     *      (FXRP 6, WFLR and WETH 18). Feed decimals are NOT carried: they are read from the
     *      feed at execution time, because they vary by feed *and by network* — USDT/USD reports
     *      6 on Coston2 and 5 on Flare mainnet. Pinning them in the payload would be a bug that
     *      only shows up after a deployment moves networks.
     *
     * @param feedIdIn FTSOv2 feed id for the input token, e.g. `XRP/USD`.
     * @param feedIdOut FTSOv2 feed id for the output token.
     * @param decimalsIn ERC-20 decimals of the input token.
     * @param decimalsOut ERC-20 decimals of the output token.
     * @param amountIn Input amount in the input token's base units.
     * @param maxDeviationBps How far below the oracle rate the fill may land, in basis points.
     * @param maxFeedAgeSeconds Reject the instruction if either feed is staler than this.
     */
    struct FtsoBound {
        bytes21 feedIdIn;
        bytes21 feedIdOut;
        uint8 decimalsIn;
        uint8 decimalsOut;
        uint256 amountIn;
        uint16 maxDeviationBps;
        uint64 maxFeedAgeSeconds;
    }

    /// @notice Reverts when a balance or delta assertion is not met.
    /// @param index Position of the failing condition in the payload's array.
    error PostConditionFailed(uint256 index, Kind kind, uint256 required, uint256 actual);

    /// @notice Reverts when a realised swap rate is worse than the oracle allows.
    error RateBelowOracleBound(uint256 index, uint256 requiredOut, uint256 actualOut);

    /// @notice Reverts when an FTSOv2 feed has not updated recently enough to be trusted.
    error FeedTooOld(uint256 index, bytes21 feedId, uint64 feedTimestamp, uint64 maxAgeSeconds);

    /// @notice Reverts when a feed reports a non-positive price, which no rate can be built from.
    error FeedPriceZero(uint256 index, bytes21 feedId);

    /// @notice Reverts when a feed reports negative decimals, which this implementation refuses
    ///         to interpret rather than guess at.
    error FeedDecimalsNegative(uint256 index, bytes21 feedId, int8 decimals);

    /// @notice Reverts when a condition's fields contradict its kind.
    error MalformedPostCondition(uint256 index, Kind kind);

    /// @notice Reverts when a payload carries more conditions than can be evaluated safely.
    error TooManyPostConditions(uint256 count, uint256 max);
}
