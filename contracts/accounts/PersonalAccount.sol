// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC1363Receiver} from "@openzeppelin/contracts/interfaces/IERC1363Receiver.sol";
import {IIPersonalAccount} from "../interfaces/IIPersonalAccount.sol";
import {IPersonalAccount} from "../interfaces/IPersonalAccount.sol";

/**
 * @title PersonalAccount
 * @notice The asset-holding account behind one XRPL address.
 *
 * @dev Deployed once as an implementation; every account is a beacon proxy that reads it from
 *      the standalone `PersonalAccountBeacon`. All state-changing entry points are controller-only,
 *      and the controller only calls them after verifying an FDC attestation that binds the
 *      instruction to this account's XRPL owner.
 *
 *      This account does not mint anything. It acts on balances it already holds -- which is
 *      exactly the capability Flare's `0xFF`/`0xFE` cannot reach, because those are only
 *      reachable as a side effect of `executeDirectMintingWithData`.
 */
contract PersonalAccount is IIPersonalAccount, ReentrancyGuardTransient, IERC165, IERC1363Receiver {
    using SafeERC20 for IERC20;

    string private _xrplOwner;
    address private _controller;

    modifier onlyController() {
        require(msg.sender == _controller, OnlyController(msg.sender, _controller));
        _;
    }

    /// @inheritdoc IIPersonalAccount
    function initialize(address _controllerAddress, string calldata _owner) external {
        // The proxy calls this exactly once, from its constructor, before any other caller can
        // reach it. A second call is impossible because `_controller` is then non-zero.
        require(_controller == address(0), OnlyController(msg.sender, _controller));
        _controller = _controllerAddress;
        _xrplOwner = _owner;
    }

    /// @inheritdoc IIPersonalAccount
    function executeUserOp(Call[] calldata _calls) external payable onlyController nonReentrant {
        uint256 length = _calls.length;
        require(length > 0, EmptyBatch());
        for (uint256 i = 0; i < length; ++i) {
            (bool ok, bytes memory reason) = _call(_calls[i]);
            require(ok, CallFailed(i, reason));
        }
        emit UserOpExecuted(length);
    }

    /// @dev Most revert data the account carries back out of a failed call. Enough for any
    ///      standard error (selector plus a few words, or a short string) and for the account's
    ///      own `CallFailed` wrapper to stay small.
    uint256 internal constant MAX_REVERT_BYTES = 256;

    /**
     * @dev Makes one call and returns a bounded copy of the revert reason.
     *
     *      A plain `target.call(data)` copies the callee's entire return data into memory, on
     *      success as well as failure, and the failure path then re-encodes it into `CallFailed`.
     *      The callee chooses how much that is, so a payload can make the transaction cost more
     *      for whoever sends it (`test/ExecutorEconomics.t.sol` measured 341k gas at 32 bytes and
     *      2.0M at 300 KB). The instruction's owner would then bill the executor for a revert.
     *      Copying nothing on success and at most `MAX_REVERT_BYTES` on failure removes that lever.
     */
    function _call(Call calldata _c) private returns (bool ok, bytes memory reason) {
        address target = _c.target;
        uint256 value = _c.value;
        bytes calldata data = _c.data;
        uint256 size;
        // solhint-disable-next-line no-inline-assembly
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            calldatacopy(ptr, data.offset, data.length)
            ok := call(gas(), target, value, ptr, data.length, 0, 0)
            size := returndatasize()
            if iszero(ok) {
                if gt(size, MAX_REVERT_BYTES) { size := MAX_REVERT_BYTES }
                reason := mload(0x40)
                mstore(reason, size)
                returndatacopy(add(reason, 0x20), 0, size)
                mstore(0x40, and(add(add(reason, add(size, 0x20)), 0x1f), not(0x1f)))
            }
        }
    }

    /// @inheritdoc IIPersonalAccount
    function payExecutorFee(address _token, address _to, uint256 _amount)
        external
        onlyController
        nonReentrant
    {
        IERC20(_token).safeTransfer(_to, _amount);
        emit ExecutorFeePaid(_token, _to, _amount);
    }

    /// @inheritdoc IPersonalAccount
    function xrplOwner() external view returns (string memory) {
        return _xrplOwner;
    }

    /// @inheritdoc IPersonalAccount
    function controller() external view returns (address) {
        return _controller;
    }

    /**
     * @notice ERC-1363 receiver hook: accept `transferAndCall` / `approveAndCall` deposits.
     * @dev Matches Flare's live `PersonalAccount` (Coston2 and mainnet, checked 2026-09-21): it
     *      accepts unconditionally and returns the magic value. Plain ERC-20 transfers into the
     *      account have always worked -- the Phase 1 trace depended on one -- but a counterparty
     *      that pays with `transferAndCall` reverts against any receiver that lacks this function,
     *      because the token requires the magic value back.
     *
     *      It does nothing else on purpose. The account's assets are moved only by an attested
     *      instruction, so an unconditional accept cannot be turned into a way to spend them; the
     *      worst a hostile token can do is deposit itself.
     */
    function onTransferReceived(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC1363Receiver.onTransferReceived.selector;
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 _interfaceId) external pure returns (bool) {
        return _interfaceId == type(IPersonalAccount).interfaceId || _interfaceId == type(IERC165).interfaceId
            || _interfaceId == type(IERC1363Receiver).interfaceId;
    }

    receive() external payable {}
}
