// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {MockERC20} from "../contracts/mocks/MockERC20.sol";
import {MockERC4626} from "../contracts/mocks/MockERC4626.sol";

/**
 * @title DeployMocks
 * @notice Deploys a mintable token and an ERC-4626 vault on Coston2, and funds an account.
 *
 * @dev Why this exists. The real end-to-end target is one of the four funded Coston2 vaults,
 *      whose asset is FTestXRP -- which cannot be minted freely, so getting it into a
 *      personal account means running the FAssets mint once, out of band. That is a
 *      prerequisite worth doing, but it is not the thing Phase 1 is trying to prove.
 *
 *      Running the trace against a mock token and vault first exercises every part that can
 *      actually fail -- the XRPL payment, the offline request encoding, the attestation, the
 *      DA Layer poll, the proof verification, the dispatch -- against real Flare
 *      infrastructure. Only the deposit target is synthetic. Once FTestXRP is in hand, the
 *      same script runs against a live vault with nothing changed but two addresses.
 *
 *      MINT_TO should be the personal account address, available from
 *      `computeAccountAddress` before the account is deployed. Funding it here, ahead of the
 *      instruction, is the point: the instruction acts on a balance that already exists.
 *
 *   forge script scripts/DeployMocks.s.sol:DeployMocks \
 *     --rpc-url https://coston2-api.flare.network/ext/C/rpc --broadcast
 */
contract DeployMocks is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address mintTo = vm.envAddress("MINT_TO");
        uint256 mintAmount = vm.envOr("MINT_AMOUNT", uint256(100_000_000)); // 100 units at 6dp

        vm.startBroadcast(pk);

        // Six decimals and an XRP-shaped name, so the trace reads like the real thing.
        MockERC20 token = new MockERC20("Mock TestXRP", "mTestXRP", 6);
        MockERC4626 vault = new MockERC4626(token, "Mock earnXRP", "mEarnXRP");
        token.mint(mintTo, mintAmount);

        // A little depth so the vault is not a degenerate first-depositor case.
        uint256 seed = vm.envOr("VAULT_SEED", uint256(10_000_000));
        token.mint(vm.addr(pk), seed);
        token.approve(address(vault), seed);
        vault.deposit(seed, vm.addr(pk));

        vm.stopBroadcast();

        console.log("mock asset ", address(token));
        console.log("mock vault ", address(vault));
        console.log("funded     ", mintTo, mintAmount);
        console.log("vault seed ", seed);

        vm.writeFile(
            "fixtures/mocks.json",
            string.concat(
                '{\n  "chainId": ', vm.toString(block.chainid),
                ',\n  "asset": "', vm.toString(address(token)),
                '",\n  "vault": "', vm.toString(address(vault)),
                '",\n  "fundedAccount": "', vm.toString(mintTo),
                '",\n  "fundedAmount": "', vm.toString(mintAmount),
                '"\n}\n'
            )
        );
        console.log("wrote fixtures/mocks.json");
    }
}
