// SPDX-License-Identifier: MIT
// Test doubles for ENSv2, modelled on docs.ens.domains (Nov 2026). Not ENS's code.
//
// MockPermissionedResolver: setText(bytes dnsName, ...), resolve(), hasRoles(),
//   EACRolesChanged, EACUnauthorizedAccountRoles, and BOTH delegation APIs the
//   docs describe, selected at deploy time:
//     setterApi = false: authorizeTextRoles(name, key, account, grant); resource per (name, key)
//     setterApi = true:  grantSetterRoles(setterCalldata, account) / revokeRoles(); resource = keccak256(key)
// MockUniversalResolver: findResolver() and resolveWithGateways(), as viem calls them.
pragma solidity ^0.8.24;

contract MockPermissionedResolver {
    uint256 constant ROLE_SET_TEXT = 1 << 4;
    uint256 constant ROLE_SET_TEXT_ADMIN = ROLE_SET_TEXT << 128;
    uint256 constant ROOT = 0;

    bool public immutable setterApi;
    mapping(uint256 => mapping(address => uint256)) internal _roles;
    mapping(bytes32 => mapping(string => string)) internal _texts;

    event EACRolesChanged(uint256 indexed resource, address indexed account, uint256 oldRoleBitmap, uint256 newRoleBitmap);
    error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account);

    constructor(bool _setterApi) {
        setterApi = _setterApi;
        _setRoles(ROOT, msg.sender, ROLE_SET_TEXT | ROLE_SET_TEXT_ADMIN);
    }

    function hasRoles(uint256 resource, uint256 roleBitmap, address account) public view returns (bool) {
        return ((_roles[resource][account] | _roles[ROOT][account]) & roleBitmap) == roleBitmap;
    }

    function roles(uint256 resource, address account) external view returns (uint256) {
        return _roles[resource][account];
    }

    function _setRoles(uint256 resource, address account, uint256 bits) internal returns (bool) {
        uint256 old = _roles[resource][account];
        if (old == bits) return false;
        _roles[resource][account] = bits;
        emit EACRolesChanged(resource, account, old, bits);
        return true;
    }

    function _requireAdmin() internal view {
        if (!hasRoles(ROOT, ROLE_SET_TEXT_ADMIN, msg.sender)) revert EACUnauthorizedAccountRoles(ROOT, ROLE_SET_TEXT_ADMIN, msg.sender);
    }

    function _textResource(bytes32 node, string memory key) internal view returns (uint256) {
        if (setterApi) return uint256(keccak256(bytes(key)));
        return uint256(keccak256(abi.encode(node, keccak256(bytes(key)))));
    }

    // --- older documented API ---
    function authorizeTextRoles(bytes calldata toName, string calldata key, address account, bool grant) external returns (bool) {
        require(!setterApi);
        _requireAdmin();
        uint256 r = _textResource(namehash(toName, 0), key);
        uint256 cur = _roles[r][account];
        return _setRoles(r, account, grant ? cur | ROLE_SET_TEXT : cur & ~ROLE_SET_TEXT);
    }

    // --- newer documented API ---
    function grantSetterRoles(bytes calldata setter, address account) external returns (bool) {
        require(setterApi);
        _requireAdmin();
        require(bytes4(setter[:4]) == this.setText.selector, "only setText");
        (, string memory key,) = abi.decode(setter[4:], (bytes, string, string));
        uint256 r = _textResource(bytes32(0), key);
        return _setRoles(r, account, _roles[r][account] | ROLE_SET_TEXT);
    }

    function revokeRoles(uint256 resource, uint256 roleBitmap, address account) external returns (bool) {
        require(setterApi);
        _requireAdmin();
        return _setRoles(resource, account, _roles[resource][account] & ~roleBitmap);
    }

    // --- records ---
    function setText(bytes calldata name, string calldata key, string calldata value) external {
        bytes32 node = namehash(name, 0);
        uint256 r = _textResource(node, key);
        if (!hasRoles(r, ROLE_SET_TEXT, msg.sender)) revert EACUnauthorizedAccountRoles(r, ROLE_SET_TEXT, msg.sender);
        _texts[node][key] = value;
    }

    function resolve(bytes calldata, bytes calldata data) external view returns (bytes memory) {
        require(bytes4(data[:4]) == bytes4(keccak256("text(bytes32,string)")), "unsupported profile");
        (bytes32 node, string memory key) = abi.decode(data[4:], (bytes32, string));
        return abi.encode(_texts[node][key]);
    }

    function namehash(bytes memory name, uint256 offset) public pure returns (bytes32) {
        uint256 len = uint8(name[offset]);
        if (len == 0) return bytes32(0);
        bytes32 parent = namehash(name, offset + len + 1);
        bytes32 label;
        assembly { label := keccak256(add(add(name, 32), add(offset, 1)), len) }
        return keccak256(abi.encodePacked(parent, label));
    }
}

contract MockUniversalResolver {
    mapping(bytes32 => address) public resolvers;
    error ResolverNotFound(bytes name);

    function setResolver(bytes calldata name, address r) external {
        resolvers[keccak256(name)] = r;
    }

    function findResolver(bytes calldata name) external view returns (address, bytes32, uint256) {
        return (resolvers[keccak256(name)], bytes32(0), 0);
    }

    function resolveWithGateways(bytes calldata name, bytes calldata data, string[] calldata) external view returns (bytes memory, address) {
        address r = resolvers[keccak256(name)];
        if (r == address(0)) revert ResolverNotFound(name);
        (bool ok, bytes memory ret) = r.staticcall(abi.encodeWithSignature("resolve(bytes,bytes)", name, data));
        require(ok, "resolve failed");
        return (abi.decode(ret, (bytes)), r);
    }
}
