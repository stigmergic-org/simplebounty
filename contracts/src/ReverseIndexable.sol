/* SPDX-License-Identifier: GPL-3.0-only
  ▄▄▄▄▄▄▄▄▄▄  ▄▄  ▄                                           ▄  ▄▄  ▄▄▄▄▄▄▄▄▄▄
 █▄▓▄                                                                       ▄▓▄█
 █         ▒██████  █▓ ▓██▄ ▄██▄ ██▓███  ██▓   ███████ ██████ ██████▒          █
 █         ██▒      ██ ▒██▀█▀ █▓██░  ██▒██▒    ▓█   ▀  ██  ██ ██  ██           █
 █          ██████  ██ ▓██ █  █▓██░ ██▓▒██░    ▒███    ██████ ██ ▄▄▒           █
 █              ██▒ ██ ▓██ █  █▒██▄█▓▒ ▒██░    ▒▓█  ▄  ██     ██  ██           █
 █         ███████▒ ██▒▒██ █  █▒██▒ ░  ░██████▒▓█████▒ ██     ██████           █
 █         ░ ▒░▒░▒░ ▓ ░ ▒░ ░  ▒▒▓▒░ ░  ░▒ ▒░▓  ░░ ▒░ ░ ░░▒    ░░▒▒▓▒           █
 █           ░ ▒ ▒░ ▒ ░ ░░    ▒░▒ ░     ░ ░ ▒  ░░ ░  ░ ░   ░  ░ ░▒░            █
 █         ░ ░ ░ ▒ ▒    ░     ░░░         ░ ░     ░         ░   ░ ░            █
 █            ░ ░  ░            ░              ░  ░   ░  ░   ░░ ░              █
  ▄▄▄▄▄▄▄ ▄         ░            ░            ░  ░              ░     ▄ ▄▄▄▄▄▄▄
 █▄▓▄▄                           ░                                         ▄▄▓▄█
 █                                                                             █
 █  ░  Release Information                                                     █
 █  ░ ---------------- -                                                       █
 █                                                                             █
 █  ░  Contract . : ReverseIndexable                                           █
 █  ░  License .. : GPL-3.0-only                                               █
 █  ░  Language . : Solidity                                                   █
 █  ░  Type ..... : Abstract Contract                                          █
 ▓  ░  Version .. : 1.0.0                                                      ▓
 ▒  ░  Created .. : 2025-11-03                                                 ▒
 ░                                                                             ░
*/
pragma solidity ^0.8.13;

/// @title ReverseIndexable
/// @notice Abstract contract that tracks the last block number when the contract was indexed
/// @dev Provides a touchIndex() function and emits events when blockPointer is updated
/// 
/// Indexing Pattern:
/// This contract creates a linked chain of blocks with contract activity, enabling efficient indexing
/// without scanning every block. Each time touchIndex() is called, it records the current block and links
/// to the previous activity block through an event.
///
/// To build a complete index:
/// - Start by reading blockPointer from current state to find the most recent activity block
/// - Query eth_getLogs for that block to get all contract events (transfers, assertions, etc.)
/// - The BlockPointer event in that block reveals the previous activity block number
/// - Follow this chain recursively backward until reaching block 0
///
/// Implementation Note:
/// Inheriting contracts must call touchIndex() on every block that contains contract activity. If a contract
/// emits an event, but doesn't call touchIndex(), the event will not be discoverable through this indexing pattern.
abstract contract ReverseIndexable {
    uint256 public blockPointer;

    /// @notice Emitted when the contract is indexed
    /// @param previousBlock The previous block number when the contract had activity
    event BlockPointer(uint256 previousBlock);

    /// @notice Records the current block number in the reverse-indexable chain
    /// @dev Emits a BlockPointer event with the previous block pointer value, then updates blockPointer.
    ///      Subsequent calls within the same block are ignored to avoid duplicate pointers.
    function touchIndex() internal {
        uint256 previousBlock = blockPointer;
        if (previousBlock == block.number) return;
        emit BlockPointer(previousBlock);
        blockPointer = block.number;
    }
}