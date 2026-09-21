// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/**
 * @notice Stand-in for FTSOv2, so rate bounds can be tested across decimal combinations.
 * @dev Decimals are per-feed and settable because that is how the real thing behaves: on live
 *      networks USDT/USD reports 6 decimals on Coston2 and 5 on Flare mainnet, and the values
 *      observed across feeds range from 2 (BTC/USD) to 9 (SGB/USD on Coston2).
 */
contract MockFtsoV2 {
    struct Feed {
        uint256 value;
        int8 decimals;
        uint64 timestamp;
        bool set;
    }

    mapping(bytes21 feedId => Feed) private _feeds;

    error UnknownFeed(bytes21 feedId);

    function setFeed(bytes21 _feedId, uint256 _value, int8 _decimals, uint64 _timestamp) external {
        _feeds[_feedId] = Feed({value: _value, decimals: _decimals, timestamp: _timestamp, set: true});
    }

    /// @dev `payable` to match the real interface, which is why a rate bound cannot be `view`.
    function getFeedById(bytes21 _feedId)
        external
        payable
        returns (uint256 _value, int8 _decimals, uint64 _timestamp)
    {
        Feed memory f = _feeds[_feedId];
        require(f.set, UnknownFeed(_feedId));
        return (f.value, f.decimals, f.timestamp);
    }
}
