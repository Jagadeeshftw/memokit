// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/**
 * @title Execution
 * @notice Replay protection, per-account nonces, and the recovery state that unsticks a
 *         payment whose memo cannot execute.
 *
 * @dev XRPL payments are irreversible. If an instruction can never succeed, the nonce sequence
 *      behind it is blocked forever unless there is a way to move past it. Flare needed three
 *      recovery opcodes for this; memokit implements the same three at the same opcode values.
 *
 *      memokit has one advantage over Flare here: there is no minted asset to strand, because
 *      no mint happens. `0xE0` therefore only retires a transaction id, it does not release
 *      funds. The nonce problem is identical, so `0xE1` matters just as much.
 *
 *      Lockout cannot occur: `execute` is open to any caller, so an account owner who cannot
 *      find a paid executor can always submit a zero-fee recovery memo themselves.
 */
library Execution {
    /// @custom:storage-location erc7201:memokit.Execution.State
    struct State {
        /// @notice One XRPL transaction can drive at most one on-chain action.
        mapping(bytes32 transactionId => bool) usedTransactionIds;
        /// @notice Per-account instruction nonce. Advances only on a successful 0xFD/0xFC.
        mapping(address account => uint256 nonce) nonces;
        /// @notice Transaction ids whose memo should be skipped for this account.
        mapping(address account => mapping(bytes32 transactionId => bool)) ignored;
        /// @notice Fee override, stored as `fee + 1` so that 0 keeps meaning "unset".
        mapping(address account => mapping(bytes32 transactionId => uint64)) replacementFee;
    }

    bytes32 internal constant STATE_POSITION =
        keccak256(abi.encode(uint256(keccak256("memokit.Execution.State")) - 1)) & ~bytes32(uint256(0xff));

    event IgnoreSet(address indexed account, bytes32 indexed targetTransactionId);
    event NonceSet(address indexed account, uint256 newNonce);
    event ReplacementFeeSet(address indexed account, bytes32 indexed targetTransactionId, uint64 newFee);

    error TransactionAlreadyUsed(bytes32 transactionId);
    error InvalidNonce(uint256 expected, uint256 actual);
    error InvalidNonceIncrease(uint256 current, uint256 requested);

    /// @notice Mark an XRPL transaction as consumed, reverting if it already was.
    function consume(bytes32 _transactionId) internal {
        State storage state = getState();
        require(!state.usedTransactionIds[_transactionId], TransactionAlreadyUsed(_transactionId));
        state.usedTransactionIds[_transactionId] = true;
    }

    /// @notice Check and consume the ignore flag for `(_account, _transactionId)`.
    /// @return _wasIgnored True when a flag was set and has now been cleared.
    function takeIgnoreFlag(address _account, bytes32 _transactionId) internal returns (bool _wasIgnored) {
        State storage state = getState();
        if (state.ignored[_account][_transactionId]) {
            delete state.ignored[_account][_transactionId];
            return true;
        }
        return false;
    }

    function setIgnore(address _account, bytes32 _targetTransactionId) internal {
        getState().ignored[_account][_targetTransactionId] = true;
        emit IgnoreSet(_account, _targetTransactionId);
    }

    /**
     * @notice Advance an account's nonce.
     * @dev Must strictly increase. The jump is capped at `type(uint32).max` so a single
     *      malformed memo cannot brick the account by setting the nonce near `uint256.max`.
     */
    function setNonce(address _account, uint256 _newNonce) internal {
        State storage state = getState();
        uint256 current = state.nonces[_account];
        require(
            _newNonce > current && _newNonce - current <= type(uint32).max,
            InvalidNonceIncrease(current, _newNonce)
        );
        state.nonces[_account] = _newNonce;
        emit NonceSet(_account, _newNonce);
    }

    /// @notice Check `_nonce` against the account's current nonce and increment on success.
    function useNonce(address _account, uint256 _nonce) internal {
        State storage state = getState();
        uint256 expected = state.nonces[_account];
        require(_nonce == expected, InvalidNonce(expected, _nonce));
        state.nonces[_account] = expected + 1;
    }

    function setReplacementFee(address _account, bytes32 _targetTransactionId, uint64 _newFee) internal {
        getState().replacementFee[_account][_targetTransactionId] = _newFee + 1;
        emit ReplacementFeeSet(_account, _targetTransactionId, _newFee);
    }

    /**
     * @notice Resolve the fee for this execution, consuming any override.
     * @param _memoFee Fee from the memo header.
     * @return _fee The fee to pay the executor.
     */
    function resolveFee(address _account, bytes32 _transactionId, uint64 _memoFee)
        internal
        returns (uint64 _fee)
    {
        State storage state = getState();
        uint64 stored = state.replacementFee[_account][_transactionId];
        if (stored > 0) {
            delete state.replacementFee[_account][_transactionId];
            return stored - 1;
        }
        return _memoFee;
    }

    function getState() internal pure returns (State storage _state) {
        bytes32 position = STATE_POSITION;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            _state.slot := position
        }
    }
}
