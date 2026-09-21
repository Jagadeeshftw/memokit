// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IXRPPayment} from "flare-periphery/coston2/IXRPPayment.sol";

/// @notice Stands in for `FdcVerification.verifyXRPPayment` so tests can exercise both answers.
contract MockFdcVerification {
    bool public result = true;

    function setResult(bool _result) external {
        result = _result;
    }

    function verifyXRPPayment(IXRPPayment.Proof calldata) external view returns (bool) {
        return result;
    }
}
