// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// The token on the other side of Canary Swap's Sepolia pool. It has no value:
/// anyone can mint up to 1,000 at a time to try the swap in both directions.
contract CanaryTestToken {
    string public constant name = "Canary Test Token";
    string public constant symbol = "CNRY";
    uint8 public constant decimals = 18;
    uint256 public constant MINT_MAX = 1000e18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(address to, uint256 amount) {
        _mint(to, amount);
    }

    function mint(address to, uint256 amount) external {
        require(amount <= MINT_MAX, "CNRY: at most 1000 per mint");
        _mint(to, amount);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "CNRY: allowance");
            allowance[from][msg.sender] = allowed - value;
        }
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) internal {
        require(balanceOf[from] >= value, "CNRY: balance");
        unchecked {
            balanceOf[from] -= value;
        }
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    function _mint(address to, uint256 value) internal {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }
}
