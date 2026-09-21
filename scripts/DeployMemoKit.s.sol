// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {Diamond} from "../contracts/diamond/Diamond.sol";
import {DiamondCutFacet} from "../contracts/diamond/DiamondCutFacet.sol";
import {DiamondLoupeFacet} from "../contracts/diamond/DiamondLoupeFacet.sol";
import {IDiamondCut} from "../contracts/diamond/IDiamondCut.sol";
import {AccountsFacet} from "../contracts/facets/AccountsFacet.sol";
import {AdminFacet} from "../contracts/facets/AdminFacet.sol";
import {MemoControllerFacet} from "../contracts/facets/MemoControllerFacet.sol";
import {PersonalAccount} from "../contracts/accounts/PersonalAccount.sol";
import {PersonalAccountBeacon} from "../contracts/accounts/PersonalAccountBeacon.sol";
import {FacetSelectors} from "./lib/FacetSelectors.sol";

/**
 * @title DeployMemoKit
 * @notice Deploys the memokit diamond and its facets, then configures it.
 *
 * Coston2 defaults are baked in as fallbacks; everything is overridable by environment.
 *
 *   forge script scripts/DeployMemoKit.s.sol:DeployMemoKit \
 *     --rpc-url https://coston2-api.flare.network/ext/C/rpc --broadcast
 *
 * Required env: PRIVATE_KEY, MEMOKIT_RECEIVING_ADDRESS (an XRPL address the operator controls).
 *
 * @dev Addresses are held in a struct rather than locals: the flat version overflows the
 *      stack, and the repo builds without `via_ir` to keep iteration fast.
 */
contract DeployMemoKit is Script {
    /// @dev FTestXRP on Coston2 -- the token executors are paid in by default.
    address internal constant COSTON2_FTESTXRP = 0x0b6A3645c240605887a5532109323A3E12273dc7;

    struct Deployed {
        address diamond;
        address diamondCutFacet;
        address diamondLoupeFacet;
        address memoControllerFacet;
        address adminFacet;
        address accountsFacet;
        address personalAccountImplementation;
        address personalAccountBeacon;
    }

    struct Config {
        address owner;
        string receivingAddress;
        bytes32 sourceId;
        uint64 validitySeconds;
        uint64 timelockSeconds;
        address feeToken;
    }

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        Config memory config = _config(vm.addr(pk));

        vm.startBroadcast(pk);
        Deployed memory deployed = _deployFacets(vm.addr(pk));
        _cut(deployed);
        _initialize(deployed, config);
        vm.stopBroadcast();

        _report(deployed, config);
    }

    function _config(address _deployer) internal view returns (Config memory _c) {
        _c.owner = vm.envOr("MEMOKIT_OWNER", _deployer);
        _c.receivingAddress = vm.envString("MEMOKIT_RECEIVING_ADDRESS");
        _c.sourceId = bytes32(bytes(vm.envOr("MEMOKIT_SOURCE_ID", string("testXRP"))));
        _c.validitySeconds = uint64(vm.envOr("MEMOKIT_VALIDITY_SECONDS", uint256(86_400)));
        _c.timelockSeconds = uint64(vm.envOr("MEMOKIT_TIMELOCK_SECONDS", uint256(3_600)));
        _c.feeToken = vm.envOr("MEMOKIT_FEE_TOKEN", COSTON2_FTESTXRP);
    }

    function _deployFacets(address _deployer) internal returns (Deployed memory _d) {
        _d.diamondCutFacet = address(new DiamondCutFacet());
        _d.diamond = address(new Diamond(_deployer, _d.diamondCutFacet));
        _d.memoControllerFacet = address(new MemoControllerFacet());
        _d.adminFacet = address(new AdminFacet());
        _d.accountsFacet = address(new AccountsFacet());
        _d.diamondLoupeFacet = address(new DiamondLoupeFacet());
        _d.personalAccountImplementation = address(new PersonalAccount());
        _d.personalAccountBeacon =
            address(new PersonalAccountBeacon(_d.diamond, _d.personalAccountImplementation));
    }

    function _cut(Deployed memory _d) internal {
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](4);
        cuts[0] = FacetSelectors.add(_d.memoControllerFacet, FacetSelectors.controller());
        cuts[1] = FacetSelectors.add(_d.adminFacet, FacetSelectors.admin());
        cuts[2] = FacetSelectors.add(_d.accountsFacet, FacetSelectors.accounts());
        cuts[3] = FacetSelectors.add(_d.diamondLoupeFacet, FacetSelectors.loupe());
        IDiamondCut(_d.diamond).diamondCut(cuts, address(0), "");
    }

    function _initialize(Deployed memory _d, Config memory _c) internal {
        string[] memory receiving = new string[](1);
        receiving[0] = _c.receivingAddress;
        address[] memory pausers = new address[](1);
        pausers[0] = _c.owner;

        AdminFacet(_d.diamond).initializeMemoKit(
            AdminFacet.InitParams({
                owner: _c.owner,
                accountBeacon: _d.personalAccountBeacon,
                sourceId: _c.sourceId,
                validityDurationSeconds: _c.validitySeconds,
                timelockDurationSeconds: _c.timelockSeconds,
                feeToken: _c.feeToken,
                receivingAddresses: receiving,
                pausers: pausers,
                unpausers: pausers
            })
        );
    }

    function _report(Deployed memory _d, Config memory _c) internal {
        console.log("memokit diamond      ", _d.diamond);
        console.log("  DiamondCutFacet    ", _d.diamondCutFacet);
        console.log("  DiamondLoupeFacet  ", _d.diamondLoupeFacet);
        console.log("  MemoControllerFacet", _d.memoControllerFacet);
        console.log("  AdminFacet         ", _d.adminFacet);
        console.log("  AccountsFacet      ", _d.accountsFacet);
        console.log("  PersonalAccount    ", _d.personalAccountImplementation);
        console.log("  AccountBeacon      ", _d.personalAccountBeacon);
        console.log("owner                ", _c.owner);
        console.log("fee token            ", _c.feeToken);
        console.log("receiving address    ", _c.receivingAddress);

        vm.writeFile("fixtures/deployment.json", _json(_d, _c));
        console.log("wrote fixtures/deployment.json");
    }

    function _json(Deployed memory _d, Config memory _c) internal view returns (string memory) {
        return string.concat(
            '{\n  "chainId": ', vm.toString(block.chainid),
            ',\n  "diamond": "', vm.toString(_d.diamond),
            '",\n  "diamondCutFacet": "', vm.toString(_d.diamondCutFacet),
            '",\n  "diamondLoupeFacet": "', vm.toString(_d.diamondLoupeFacet),
            '",\n  "memoControllerFacet": "', vm.toString(_d.memoControllerFacet),
            '",\n  "adminFacet": "', vm.toString(_d.adminFacet),
            '",\n  "accountsFacet": "', vm.toString(_d.accountsFacet),
            '",\n  "personalAccountImplementation": "', vm.toString(_d.personalAccountImplementation),
            '",\n  "personalAccountBeacon": "', vm.toString(_d.personalAccountBeacon),
            '",\n  "owner": "', vm.toString(_c.owner),
            '",\n  "feeToken": "', vm.toString(_c.feeToken),
            '",\n  "receivingAddress": "', _c.receivingAddress,
            '"\n}\n'
        );
    }
}
