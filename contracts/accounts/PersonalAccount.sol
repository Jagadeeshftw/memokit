// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IIPersonalAccount} from "../interfaces/IIPersonalAccount.sol";
import {IPersonalAccount} from "../interfaces/IPersonalAccount.sol";

/**
 * @title PersonalAccount
 * @notice The asset-holding account behind one XRPL address.
 *
 * @dev Deployed once as an implementation; every account is a beacon proxy pointing here, with
 *      the controller acting as the beacon. All state-changing entry points are controller-only,
 *      and the controller only calls them after verifying an FDC attestation that binds the
 *      instruction to this account's XRPL owner.
 *
 *      This account does not mint anything. It acts on balances it already holds -- which is
 *      exactly the capability Flare's `0xFF`/`0xFE` cannot reach, because those are only
 *      reachable as a side effect of `executeDirectMintingWithData`.
 */
contract PersonalAccount is IIPersonalAccount, ReentrancyGuardTransient, IERC165 {
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
            (bool ok, bytes memory returnData) =
                _calls[i].target.call{value: _calls[i].value}(_calls[i].data);
            require(ok, CallFailed(i, returnData));
        }
        emit UserOpExecuted(length);
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

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 _interfaceId) external pure returns (bool) {
        return _interfaceId == type(IPersonalAccount).interfaceId || _interfaceId == type(IERC165).interfaceId;
    }

    receive() external payable {}
}
