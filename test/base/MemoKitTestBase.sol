// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IXRPPayment} from "flare-periphery/coston2/IXRPPayment.sol";

import {Diamond} from "../../contracts/diamond/Diamond.sol";
import {DiamondCutFacet} from "../../contracts/diamond/DiamondCutFacet.sol";
import {DiamondLoupeFacet} from "../../contracts/diamond/DiamondLoupeFacet.sol";
import {IDiamondCut} from "../../contracts/diamond/IDiamondCut.sol";

import {AccountsFacet} from "../../contracts/facets/AccountsFacet.sol";
import {AdminFacet} from "../../contracts/facets/AdminFacet.sol";
import {MemoControllerFacet} from "../../contracts/facets/MemoControllerFacet.sol";
import {FacetSelectors} from "../../scripts/lib/FacetSelectors.sol";

import {PersonalAccount} from "../../contracts/accounts/PersonalAccount.sol";
import {PersonalAccountBeacon} from "../../contracts/accounts/PersonalAccountBeacon.sol";
import {Accounts} from "../../contracts/libraries/Accounts.sol";
import {MemoCodec} from "../../contracts/libraries/MemoCodec.sol";
import {IMemoController} from "../../contracts/interfaces/IMemoController.sol";
import {IPersonalAccount} from "../../contracts/interfaces/IPersonalAccount.sol";
import {IPostConditions} from "../../contracts/interfaces/IPostConditions.sol";

import {MockContractRegistry} from "../../contracts/mocks/MockContractRegistry.sol";
import {MockERC20} from "../../contracts/mocks/MockERC20.sol";
import {MockERC4626} from "../../contracts/mocks/MockERC4626.sol";
import {MockFdcVerification} from "../../contracts/mocks/MockFdcVerification.sol";
import {MockFtsoV2} from "../../contracts/mocks/MockFtsoV2.sol";
import {MockSingletonFactory} from "../../contracts/mocks/MockSingletonFactory.sol";

/// @notice Shared setup: a fully cut memokit diamond, mocked Flare infrastructure, a vault.
abstract contract MemoKitTestBase is Test {
    address internal constant FLARE_CONTRACT_REGISTRY = 0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019;

    address internal owner = makeAddr("owner");
    address internal pauser = makeAddr("pauser");
    address internal executor = makeAddr("executor");

    /// @dev Real Coston2 values, so the tests read like the deployment.
    string internal constant RECEIVING = "rEyj8nsHLdgt79KJWzXR5BgF7ZbaohbXwq";
    string internal constant XRPL_SENDER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
    bytes32 internal constant SOURCE_ID = bytes32("testXRP");
    uint64 internal constant VALIDITY_SECONDS = 86_400;
    uint64 internal constant TIMELOCK_SECONDS = 3_600;

    Diamond internal diamond;
    MemoControllerFacet internal controller;
    AdminFacet internal admin;
    AccountsFacet internal accounts;
    DiamondLoupeFacet internal loupe;

    MockFdcVerification internal fdc;
    MockFtsoV2 internal ftso;
    MockContractRegistry internal registry;
    MockERC20 internal fxrp;
    MockERC4626 internal vault;
    PersonalAccountBeacon internal beacon;

    function setUp() public virtual {
        _installFlareInfrastructure();
        _deployMemoKit(SOURCE_ID, RECEIVING);

        fxrp = new MockERC20("Test FXRP", "FTestXRP", 6);
        vault = new MockERC4626(fxrp, "TESTearnXRP", "TESTearnXRP");

        // XRPL block timestamps below are absolute; start the chain clock somewhere sane.
        vm.warp(1_750_000_000);
    }

    /// @dev Deploys and initialises a memokit diamond in the current EVM. Split out of `setUp` so a
    ///      fork test can deploy the same thing next to real contracts, with no mocks etched.
    function _deployMemoKit(bytes32 _sourceId, string memory _receiving) internal {
        DiamondCutFacet cutFacet = new DiamondCutFacet();
        diamond = new Diamond(owner, address(cutFacet));

        MemoControllerFacet controllerImpl = new MemoControllerFacet();
        AdminFacet adminImpl = new AdminFacet();
        AccountsFacet accountsImpl = new AccountsFacet();
        DiamondLoupeFacet loupeImpl = new DiamondLoupeFacet();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](4);
        cuts[0] = _cut(address(controllerImpl), _controllerSelectors());
        cuts[1] = _cut(address(adminImpl), _adminSelectors());
        cuts[2] = _cut(address(accountsImpl), _accountsSelectors());
        cuts[3] = _cut(address(loupeImpl), _loupeSelectors());

        vm.prank(owner);
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        controller = MemoControllerFacet(payable(address(diamond)));
        admin = AdminFacet(address(diamond));
        accounts = AccountsFacet(address(diamond));
        loupe = DiamondLoupeFacet(address(diamond));

        string[] memory receiving = new string[](1);
        receiving[0] = _receiving;
        address[] memory pausers = new address[](1);
        pausers[0] = pauser;

        // Deploy before the prank: a CREATE inside the argument list would consume it.
        // The beacon is a standalone contract, not a facet, so the controller keeps
        // `implementation()` off its own selector set -- see PersonalAccountBeacon.
        beacon = new PersonalAccountBeacon(address(diamond), address(new PersonalAccount()));

        vm.prank(owner);
        admin.initializeMemoKit(
            AdminFacet.InitParams({
                owner: owner,
                accountBeacon: address(beacon),
                sourceId: _sourceId,
                validityDurationSeconds: VALIDITY_SECONDS,
                timelockDurationSeconds: TIMELOCK_SECONDS,
                receivingAddresses: receiving,
                pausers: pausers,
                unpausers: pausers
            })
        );
    }

    function _installFlareInfrastructure() private {
        registry = new MockContractRegistry();
        fdc = new MockFdcVerification();
        ftso = new MockFtsoV2();
        registry.setContractAddress("FdcVerification", address(fdc));
        registry.setContractAddress("FtsoV2", address(ftso));
        vm.etch(FLARE_CONTRACT_REGISTRY, address(registry).code);
        // Re-point storage on the etched copy.
        MockContractRegistry(FLARE_CONTRACT_REGISTRY).setContractAddress("FdcVerification", address(fdc));
        MockContractRegistry(FLARE_CONTRACT_REGISTRY).setContractAddress("FtsoV2", address(ftso));

        vm.etch(Accounts.SINGLETON_FACTORY, address(new MockSingletonFactory()).code);
    }

    // --- cut helpers --------------------------------------------------------------------

    function _cut(address _facet, bytes4[] memory _selectors)
        internal
        pure
        returns (IDiamondCut.FacetCut memory)
    {
        return IDiamondCut.FacetCut({
            facetAddress: _facet,
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: _selectors
        });
    }

    // Delegated to the shared library the deploy script uses, so tests exercise exactly
    // the selector set that gets deployed.
    function _controllerSelectors() internal pure returns (bytes4[] memory) {
        return FacetSelectors.controller();
    }

    function _accountsSelectors() internal pure returns (bytes4[] memory) {
        return FacetSelectors.accounts();
    }

    function _loupeSelectors() internal pure returns (bytes4[] memory) {
        return FacetSelectors.loupe();
    }

    function _adminSelectors() internal pure returns (bytes4[] memory) {
        return FacetSelectors.admin();
    }

    // --- memo builders ------------------------------------------------------------------

    function _header(uint8 _opcode, uint8 _walletId, uint64 _fee) internal pure returns (bytes memory) {
        return abi.encodePacked(_opcode, _walletId, _fee);
    }

    /// @dev No post-conditions. Most tests do not need one; the ones that do use
    ///      `_instructionWith`.
    function _noConditions() internal pure returns (IPostConditions.PostCondition[] memory) {
        return new IPostConditions.PostCondition[](0);
    }

    /// @dev An instruction that pays no fee: token zero, amount zero.
    function _instruction(address _sender, uint256 _nonce, IPersonalAccount.Call[] memory _calls)
        internal
        pure
        returns (bytes memory)
    {
        return _instructionWith(_sender, _nonce, address(0), 0, _calls, _noConditions());
    }

    /// @dev An instruction whose executor fee is `_feeAmount` of `_feeToken`, inside the payload.
    function _instructionWithFee(
        address _sender,
        uint256 _nonce,
        address _feeToken,
        uint256 _feeAmount,
        IPersonalAccount.Call[] memory _calls
    ) internal pure returns (bytes memory) {
        return _instructionWith(_sender, _nonce, _feeToken, _feeAmount, _calls, _noConditions());
    }

    /// @dev An instruction carrying post-conditions.
    function _instructionWithConditions(
        address _sender,
        uint256 _nonce,
        IPersonalAccount.Call[] memory _calls,
        IPostConditions.PostCondition[] memory _conditions
    ) internal pure returns (bytes memory) {
        return _instructionWith(_sender, _nonce, address(0), 0, _calls, _conditions);
    }

    /// @dev The full payload: version byte, then the tuple. Every other builder goes through
    ///      here so the version can never be forgotten in one place and not another.
    function _instructionWith(
        address _sender,
        uint256 _nonce,
        address _feeToken,
        uint256 _feeAmount,
        IPersonalAccount.Call[] memory _calls,
        IPostConditions.PostCondition[] memory _conditions
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            bytes1(MemoCodec.PAYLOAD_VERSION),
            abi.encode(_sender, _nonce, _feeToken, _feeAmount, _calls, _conditions)
        );
    }

    // --- post-condition builders ---------------------------------------------------------

    function _pcErc20Balance(address _token, address _subject, uint256 _atLeast)
        internal pure returns (IPostConditions.PostCondition memory)
    {
        return IPostConditions.PostCondition({
            kind: IPostConditions.Kind.Erc20BalanceAtLeast,
            token: _token, subject: _subject, threshold: _atLeast, extra: ""
        });
    }

    function _pcErc20Delta(address _token, address _subject, uint256 _atLeast)
        internal pure returns (IPostConditions.PostCondition memory)
    {
        return IPostConditions.PostCondition({
            kind: IPostConditions.Kind.Erc20DeltaAtLeast,
            token: _token, subject: _subject, threshold: _atLeast, extra: ""
        });
    }

    function _pcNativeBalance(address _subject, uint256 _atLeast)
        internal pure returns (IPostConditions.PostCondition memory)
    {
        return IPostConditions.PostCondition({
            kind: IPostConditions.Kind.NativeBalanceAtLeast,
            token: address(0), subject: _subject, threshold: _atLeast, extra: ""
        });
    }

    function _pcNativeDelta(address _subject, uint256 _atLeast)
        internal pure returns (IPostConditions.PostCondition memory)
    {
        return IPostConditions.PostCondition({
            kind: IPostConditions.Kind.NativeDeltaAtLeast,
            token: address(0), subject: _subject, threshold: _atLeast, extra: ""
        });
    }

    function _pcFtsoRate(address _tokenOut, address _subject, IPostConditions.FtsoBound memory _b)
        internal pure returns (IPostConditions.PostCondition memory)
    {
        return IPostConditions.PostCondition({
            kind: IPostConditions.Kind.FtsoRateAtLeast,
            token: _tokenOut, subject: _subject, threshold: 0, extra: abi.encode(_b)
        });
    }

    function _conditions(IPostConditions.PostCondition memory _a)
        internal pure returns (IPostConditions.PostCondition[] memory _out)
    {
        _out = new IPostConditions.PostCondition[](1);
        _out[0] = _a;
    }

    function _conditions(
        IPostConditions.PostCondition memory _a,
        IPostConditions.PostCondition memory _b
    ) internal pure returns (IPostConditions.PostCondition[] memory _out) {
        _out = new IPostConditions.PostCondition[](2);
        _out[0] = _a;
        _out[1] = _b;
    }

    /// @dev FTSOv2 feed id for a crypto pair, e.g. `XRP/USD`.
    function _feedId(string memory _name) internal pure returns (bytes21) {
        bytes memory n = bytes(_name);
        require(n.length <= 20, "feed name too long");
        bytes memory out = new bytes(21);
        out[0] = 0x01;
        for (uint256 i = 0; i < n.length; ++i) {
            out[i + 1] = n[i];
        }
        return bytes21(out);
    }

    function _oneCall(address _target, uint256 _value, bytes memory _data)
        internal
        pure
        returns (IPersonalAccount.Call[] memory _calls)
    {
        _calls = new IPersonalAccount.Call[](1);
        _calls[0] = IPersonalAccount.Call({target: _target, value: _value, data: _data});
    }

    // --- proof builder ------------------------------------------------------------------

    struct ProofOverrides {
        bytes32 sourceId;
        uint8 status;
        uint64 blockTimestamp;
        bool hasDestinationTag;
        uint256 destinationTag;
        string receivingAddress;
        string sourceAddress;
        bytes32 sourceAddressHashOverride;
        bool useSourceAddressHashOverride;
        bool hasMemoData;
    }

    function _defaults() internal view returns (ProofOverrides memory _o) {
        _o.sourceId = SOURCE_ID;
        _o.status = 0;
        _o.blockTimestamp = uint64(block.timestamp);
        _o.hasDestinationTag = false;
        _o.destinationTag = 0;
        _o.receivingAddress = RECEIVING;
        _o.sourceAddress = XRPL_SENDER;
        _o.useSourceAddressHashOverride = false;
        _o.hasMemoData = true;
    }

    function _proof(bytes32 _transactionId, bytes memory _memo)
        internal
        view
        returns (IXRPPayment.Proof memory)
    {
        return _proofWith(_transactionId, _memo, _defaults());
    }

    function _proofWith(bytes32 _transactionId, bytes memory _memo, ProofOverrides memory _o)
        internal
        pure
        returns (IXRPPayment.Proof memory _p)
    {
        _p.merkleProof = new bytes32[](0);
        _p.data.attestationType = bytes32("XRPPayment");
        _p.data.sourceId = _o.sourceId;
        _p.data.votingRound = 1;
        _p.data.lowestUsedTimestamp = _o.blockTimestamp;
        _p.data.requestBody.transactionId = _transactionId;
        _p.data.requestBody.proofOwner = address(0);

        _p.data.responseBody.blockNumber = 1;
        _p.data.responseBody.blockTimestamp = _o.blockTimestamp;
        _p.data.responseBody.sourceAddress = _o.sourceAddress;
        _p.data.responseBody.sourceAddressHash = _o.useSourceAddressHashOverride
            ? _o.sourceAddressHashOverride
            : keccak256(bytes(_o.sourceAddress));
        _p.data.responseBody.receivingAddressHash = keccak256(bytes(_o.receivingAddress));
        _p.data.responseBody.intendedReceivingAddressHash = _p.data.responseBody.receivingAddressHash;
        _p.data.responseBody.spentAmount = 1_000_000;
        _p.data.responseBody.intendedSpentAmount = 1_000_000;
        _p.data.responseBody.receivedAmount = 1_000_000;
        _p.data.responseBody.intendedReceivedAmount = 1_000_000;
        _p.data.responseBody.hasMemoData = _o.hasMemoData;
        _p.data.responseBody.firstMemoData = _memo;
        _p.data.responseBody.hasDestinationTag = _o.hasDestinationTag;
        _p.data.responseBody.destinationTag = _o.destinationTag;
        _p.data.responseBody.status = _o.status;
    }

    // --- convenience --------------------------------------------------------------------

    function _accountFor(string memory _xrplOwner) internal view returns (address) {
        return accounts.computeAccountAddress(_xrplOwner);
    }

    function _fund(address _account, uint256 _amount) internal {
        fxrp.mint(_account, _amount);
    }
}
