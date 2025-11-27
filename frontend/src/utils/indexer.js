import { createPublicClient, http, parseAbiItem, decodeEventLog, getEventSelector } from 'viem';
import { contracts } from '../config/contracts';

/**
 * ReverseIndexable Indexer
 * 
 * This utility implements the reverse indexing pattern from ReverseIndexable.sol.
 * It recursively follows the blockPointer chain to discover all contract events.
 * 
 * Pattern:
 * 1. Read blockPointer from contract state (most recent activity block)
 * 2. Query all events in that block
 * 3. Find BlockPointer event to get previous activity block
 * 4. Recursively follow chain backward until block 0
 */

/**
 * Get all events from a specific block for the contract
 */
async function getBlockEvents(publicClient, contractAddress, blockNumber, fromBlock = 0) {
  if (blockNumber < fromBlock) {
    return [];
  }

  try {
    const blockStart = performance.now();
    // Get all events from this block in a single call
    const allEvents = await publicClient.getLogs({
      address: contractAddress,
      fromBlock: BigInt(blockNumber),
      toBlock: BigInt(blockNumber),
    });
    
    // Find and decode the BlockPointer event from the results by matching the event selector (first topic)
    const blockPointerSelector = getEventSelector(parseAbiItem('event BlockPointer(uint256 previousBlock)'));
    const blockPointerAbi = parseAbiItem('event BlockPointer(uint256 previousBlock)');
    const rawBlockPointerEvent = allEvents.find(event => {
      // First topic is the event selector (keccak256 hash of event signature)
      return event.topics && event.topics.length > 0 && event.topics[0] === blockPointerSelector;
    });
    
    // Decode the BlockPointer event if found
    let blockPointerEvent = null;
    if (rawBlockPointerEvent) {
      try {
        blockPointerEvent = decodeEventLog({
          abi: [blockPointerAbi],
          data: rawBlockPointerEvent.data,
          topics: rawBlockPointerEvent.topics,
        });
      } catch (error) {
        console.error(`Error decoding BlockPointer event at block ${blockNumber}:`, error);
      }
    }
    
    const blockTime = performance.now() - blockStart;
    if (blockTime > 100) {
      console.log(`[Indexer] Slow block fetch: block ${blockNumber} took ${blockTime.toFixed(2)}ms (${allEvents.length} events)`);
    }

    return {
      blockNumber,
      blockPointerEvent,
      allEvents,
    };
  } catch (error) {
    console.error(`Error fetching events for block ${blockNumber}:`, error);
    return {
      blockNumber,
      blockPointerEvent: null,
      allEvents: [],
    };
  }
}

/**
 * Recursively index all events using the reverse indexing pattern
 * @param {Object} publicClient - Viem public client
 * @param {string} contractAddress - SimpleBounty contract address
 * @param {number} currentBlockPointer - Current block pointer from contract state
 * @param {number} fromBlock - Starting block (usually 0 or deployment block)
 * @param {Function} onEvent - Callback for each event discovered (yields events)
 * @returns {Promise<Array>} Array of all discovered events
 */
export async function* indexContractEvents(
  publicClient,
  contractAddress,
  currentBlockPointer,
  fromBlock = 0,
  onEvent = null
) {
  const visitedBlocks = new Set();
  let nextBlock = currentBlockPointer;

  while (nextBlock > fromBlock) {
    // Avoid infinite loops
    if (visitedBlocks.has(nextBlock)) {
      console.warn(`Circular reference detected at block ${nextBlock}`);
      break;
    }
    visitedBlocks.add(nextBlock);

    const blockData = await getBlockEvents(publicClient, contractAddress, nextBlock, fromBlock);
    
    // Yield all events from this block
    for (const event of blockData.allEvents) {
      if (onEvent) {
        yield onEvent(event, blockData.blockNumber);
      } else {
        yield { event, blockNumber: blockData.blockNumber };
      }
    }

    // Get next block from BlockPointer event
    if (blockData.blockPointerEvent) {
      const previousBlock = Number(blockData.blockPointerEvent.args.previousBlock);
      nextBlock = previousBlock;
    } else {
      // No BlockPointer event means we've reached the end
      break;
    }
  }
}

/**
 * Parse and categorize events into structured data
 */
export function parseEvent(event) {
  const { eventName, args } = event;

  switch (eventName) {
    case 'BountyCreated':
      return {
        type: 'BountyCreated',
        tokenId: Number(args.tokenId),
        data: args.data,
        tokenAddr: args.tokenAddr,
        amount: args.amount,
        creator: args.creator,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
      };
    
    case 'BountyToppedUp':
      return {
        type: 'BountyToppedUp',
        tokenId: Number(args.tokenId),
        tokenAddr: args.tokenAddr,
        amount: args.amount,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
      };
    
    case 'BountyUpdated':
      return {
        type: 'BountyUpdated',
        tokenId: Number(args.tokenId),
        newData: args.newData,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
      };
    
    case 'ClaimAttempted':
      return {
        type: 'ClaimAttempted',
        tokenId: Number(args.tokenId),
        claimant: args.claimant,
        claimData: args.claimData,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
      };
    
    case 'ClaimFulfilled':
      return {
        type: 'ClaimFulfilled',
        tokenId: Number(args.tokenId),
        winner: args.winner,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
      };
    
    case 'TransferSingle':
      return {
        type: 'TransferSingle',
        operator: args.operator,
        from: args.from,
        to: args.to,
        id: Number(args.id),
        value: Number(args.value),
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
      };
    
    default:
      return {
        type: 'Unknown',
        eventName,
        args,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
      };
  }
}

/**
 * Build complete state from indexed events
 * @param {Array} events - Array of parsed events
 * @returns {Object} Complete state with bounties and claims
 */
export function buildStateFromEvents(events) {
  const bounties = new Map();
  const claims = new Map(); // tokenId -> array of claims
  const updates = new Map(); // tokenId -> array of updates

  for (const event of events) {
    switch (event.type) {
      case 'BountyCreated':
        console.log(`[Indexer] Found new bounty: tokenId=${event.tokenId}, creator=${event.creator}, amount=${event.amount}, data=${event.data}, block=${event.blockNumber}`);
        // Check if bounty already exists (from a newer block in reverse indexing)
        const existingBounty = bounties.get(event.tokenId);
        if (existingBounty) {
          // Preserve newer state (fulfilled, winner, etc.) and only update creation data
          // Don't overwrite data - existing bounty already has latest data from updates
          existingBounty.tokenAddr = event.tokenAddr;
          existingBounty.amount = event.amount;
          existingBounty.creator = event.creator;
          existingBounty.createdAt = event.blockNumber;
          // Don't overwrite lastUpdated if it's from a newer block
          if (!existingBounty.lastUpdated || event.blockNumber > existingBounty.lastUpdated) {
            existingBounty.lastUpdated = event.blockNumber;
          }
          } else {
            // Create new bounty entry
            bounties.set(parsed.tokenId, {
              tokenId: parsed.tokenId,
              data: parsed.data,
              tokenAddr: parsed.tokenAddr,
              amount: parsed.amount,
              creator: parsed.creator,
              createdAt: parsed.blockNumber,
              lastUpdated: parsed.blockNumber,
            });
          }

          // Add creation data to updates history
          if (!updates.has(parsed.tokenId)) {
            updates.set(parsed.tokenId, []);
          }
          // Add creation as the first entry
          updates.get(parsed.tokenId).unshift({
            newData: parsed.data,
            blockNumber: parsed.blockNumber,
            transactionHash: parsed.transactionHash,
            isCreation: true,
          });
          break;
      
      case 'BountyToppedUp':
        const toppedUp = bounties.get(event.tokenId);
        if (toppedUp) {
          console.log(`[Indexer] Bounty topped up: tokenId=${event.tokenId}, added=${event.amount}, new total=${(BigInt(toppedUp.amount) + BigInt(event.amount)).toString()}, block=${event.blockNumber}`);
          toppedUp.amount = (BigInt(toppedUp.amount) + BigInt(event.amount)).toString();
          toppedUp.lastUpdated = event.blockNumber;
        }
        break;
      
      case 'BountyUpdated':
        // Store update history
        if (!updates.has(event.tokenId)) {
          updates.set(event.tokenId, []);
        }
        updates.get(event.tokenId).push({
          newData: event.newData,
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash,
        });

        let updated = bounties.get(event.tokenId);
        if (!updated) {
          // Bounty doesn't exist yet (reverse indexing), create it with updated data
          console.log(`[Indexer] Bounty updated (creating): tokenId=${event.tokenId}, newData=${event.newData}, block=${event.blockNumber}`);
          updated = {
            tokenId: event.tokenId,
            data: event.newData,
            lastUpdated: event.blockNumber,
            // Other fields will be filled in by BountyCreated when processed
          };
          bounties.set(event.tokenId, updated);
        } else {
          console.log(`[Indexer] Bounty updated: tokenId=${event.tokenId}, newData=${event.newData}, block=${event.blockNumber}`);
          // Only update data if this is a newer event (don't overwrite newer data with older data)
          if (!updated.lastUpdated || event.blockNumber > updated.lastUpdated) {
            updated.data = event.newData;
            updated.lastUpdated = event.blockNumber;
          }
        }
        break;
      
      case 'ClaimAttempted':
        if (!claims.has(event.tokenId)) {
          claims.set(event.tokenId, []);
        }
        claims.get(event.tokenId).push({
          claimant: event.claimant,
          claimData: event.claimData,
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash,
        });
        break;
      
      case 'ClaimFulfilled':
        // Mark bounty as fulfilled
        const fulfilled = bounties.get(event.tokenId);
        if (fulfilled) {
          console.log(`[Indexer] Bounty fulfilled: tokenId=${event.tokenId}, winner=${event.winner}, block=${event.blockNumber}`);
          fulfilled.fulfilled = true;
          fulfilled.winner = event.winner;
          fulfilled.fulfilledAt = event.blockNumber;
          // Note: winningClaim will be read from contract in indexAllEvents function
        } else {
          console.warn(`[Indexer] ClaimFulfilled event for tokenId ${event.tokenId} but bounty not found in Map (buildStateFromEvents)`);
        }
        break;
    }
  }

  return {
    bounties: Array.from(bounties.values()),
    claims: Object.fromEntries(claims),
    updates: Object.fromEntries(updates),
  };
}

/**
 * Main indexing function that yields state updates after each block is processed
 * @param {Object} publicClient - Viem public client
 * @param {string} contractAddress - SimpleBounty contract address
 * @param {number} chainId - Chain ID
 * @yields {Object} State update with bounties and claims after each block
 */
export async function* indexAllEvents(publicClient, contractAddress, chainId) {
  const startTime = performance.now();
  try {
    // Get current block pointer from contract
    const blockPointerStart = performance.now();
    const blockPointer = await publicClient.readContract({
      address: contractAddress,
      abi: contracts.abis.SimpleBounty,
      functionName: 'blockPointer',
    });
    console.log(`[Indexer] blockPointer read took ${(performance.now() - blockPointerStart).toFixed(2)}ms`);

    const currentBlockPointer = Number(blockPointer);

    if (currentBlockPointer === 0) {
      // No activity yet - yield empty state
      console.log(`[Indexer] No activity (blockPointer = 0), took ${(performance.now() - startTime).toFixed(2)}ms`);
      yield {
        bounties: [],
        claims: {},
        updates: {},
      };
      return;
    }

    console.log(`[Indexer] Starting indexing from block ${currentBlockPointer}`);
    
    // Track state incrementally as we process blocks
    const bounties = new Map();
    const claims = new Map(); // tokenId -> array of claims
    const updates = new Map(); // tokenId -> array of updates
    let eventCount = 0;
    let lastBlockTime = performance.now();

    // Process blocks one at a time
    const visitedBlocks = new Set();
    let nextBlock = currentBlockPointer;

    while (nextBlock > 0) {
      // Avoid infinite loops
      if (visitedBlocks.has(nextBlock)) {
        console.warn(`Circular reference detected at block ${nextBlock}`);
        break;
      }
      visitedBlocks.add(nextBlock);

      const blockStart = performance.now();
      const blockData = await getBlockEvents(publicClient, contractAddress, nextBlock, 0);
      
      // Process all events in this block
      const blockEvents = [];
      for (const event of blockData.allEvents) {
        try {
          // Only decode events that have topics (indexed events)
          if (!event.topics || event.topics.length === 0) {
            continue;
          }

          // Decode event using ABI
          const decoded = decodeEventLog({
            abi: contracts.abis.SimpleBounty,
            data: event.data,
            topics: event.topics,
          });
          
          const parsed = parseEvent({
            eventName: decoded.eventName,
            args: decoded.args,
            blockNumber: Number(blockData.blockNumber),
            transactionHash: event.transactionHash,
          });
          
          blockEvents.push(parsed);
          eventCount++;
        } catch (err) {
          // Skip events that can't be decoded (might be from other contracts or unknown events)
          // This is expected for events we don't care about
        }
      }

      // Apply events from this block to build state incrementally
      for (const event of blockEvents) {
        switch (event.type) {
          case 'BountyCreated':
            console.log(`[Indexer] Found new bounty: tokenId=${event.tokenId}, creator=${event.creator}, amount=${event.amount}, data=${event.data}, block=${event.blockNumber}`);
            // Check if bounty already exists (from a newer block in reverse indexing)
            const existingBounty = bounties.get(event.tokenId);
            if (existingBounty) {
              // Preserve newer state (fulfilled, winner, etc.) and only update creation data
              // Don't overwrite data - existing bounty already has latest data from updates
              existingBounty.tokenAddr = event.tokenAddr;
              existingBounty.amount = event.amount;
              existingBounty.creator = event.creator;
              existingBounty.createdAt = event.blockNumber;
              // Don't overwrite lastUpdated if it's from a newer block
              if (!existingBounty.lastUpdated || event.blockNumber > existingBounty.lastUpdated) {
                existingBounty.lastUpdated = event.blockNumber;
              }
            } else {
              // Create new bounty entry
              bounties.set(event.tokenId, {
                tokenId: event.tokenId,
                data: event.data,
                tokenAddr: event.tokenAddr,
                amount: event.amount,
                creator: event.creator,
                createdAt: event.blockNumber,
                lastUpdated: event.blockNumber,
              });
            }

            // Add creation data to updates history
            if (!updates.has(event.tokenId)) {
              updates.set(event.tokenId, []);
            }
            // Add creation as the first entry
            updates.get(event.tokenId).unshift({
              newData: event.data,
              blockNumber: event.blockNumber,
              transactionHash: event.transactionHash,
              isCreation: true,
            });
            break;
          
          case 'BountyToppedUp':
            const toppedUp = bounties.get(event.tokenId);
            if (toppedUp) {
              console.log(`[Indexer] Bounty topped up: tokenId=${event.tokenId}, added=${event.amount}, new total=${(BigInt(toppedUp.amount) + BigInt(event.amount)).toString()}, block=${event.blockNumber}`);
              toppedUp.amount = (BigInt(toppedUp.amount) + BigInt(event.amount)).toString();
              toppedUp.lastUpdated = event.blockNumber;
            }
            break;
          
          case 'BountyUpdated':
            // Store update history
            if (!updates.has(event.tokenId)) {
              updates.set(event.tokenId, []);
            }
            updates.get(event.tokenId).push({
              newData: event.newData,
              blockNumber: event.blockNumber,
              transactionHash: event.transactionHash,
            });

            let updated = bounties.get(event.tokenId);
            if (!updated) {
              // Bounty doesn't exist yet (reverse indexing), create it with updated data
              console.log(`[Indexer] Bounty updated (creating): tokenId=${event.tokenId}, newData=${event.newData}, block=${event.blockNumber}`);
              updated = {
                tokenId: event.tokenId,
                data: event.newData,
                lastUpdated: event.blockNumber,
                // Other fields will be filled in by BountyCreated when processed
              };
              bounties.set(event.tokenId, updated);
            } else {
              console.log(`[Indexer] Bounty updated: tokenId=${event.tokenId}, newData=${event.newData}, block=${event.blockNumber}`);
              // Only update data if this is a newer event (don't overwrite newer data with older data)
              if (!updated.lastUpdated || event.blockNumber > updated.lastUpdated) {
                updated.data = event.newData;
                updated.lastUpdated = event.blockNumber;
              }
            }
            break;
          
          case 'ClaimAttempted':
            if (!claims.has(event.tokenId)) {
              claims.set(event.tokenId, []);
            }
            claims.get(event.tokenId).push({
              claimant: event.claimant,
              claimData: event.claimData,
              blockNumber: event.blockNumber,
              transactionHash: event.transactionHash,
            });
            break;
          
          case 'ClaimFulfilled':
            // Mark bounty as fulfilled
            let fulfilled = bounties.get(event.tokenId);
            if (!fulfilled) {
              // Bounty doesn't exist in Map yet - read from contract to create it
              console.warn(`[Indexer] ClaimFulfilled for tokenId ${event.tokenId} but bounty not in Map. Reading from contract...`);
              try {
                const bountyData = await publicClient.readContract({
                  address: contractAddress,
                  abi: contracts.abis.SimpleBounty,
                  functionName: 'getBounty',
                  args: [BigInt(event.tokenId)],
                });
                if (bountyData) {
                  // Create bounty entry from contract data
                  fulfilled = {
                    tokenId: event.tokenId,
                    data: bountyData[0],
                    tokenAddr: bountyData[1],
                    amount: bountyData[2].toString(),
                    winningClaim: bountyData[3],
                    fulfilled: true,
                    winner: event.winner,
                    fulfilledAt: event.blockNumber,
                    // We don't have creator or createdAt from getBounty, so leave them undefined
                  };
                  bounties.set(event.tokenId, fulfilled);
                  console.log(`[Indexer] Created bounty ${event.tokenId} from contract data (fulfilled)`);
                }
              } catch (err) {
                console.error(`[Indexer] Could not read bounty ${event.tokenId} from contract:`, err);
              }
            }
            
            if (fulfilled) {
              console.log(`[Indexer] Bounty fulfilled: tokenId=${event.tokenId}, winner=${event.winner}, block=${event.blockNumber}`);
              fulfilled.fulfilled = true;
              fulfilled.winner = event.winner;
              fulfilled.fulfilledAt = event.blockNumber;
              // Read winningClaim from contract if not already set
              if (!fulfilled.winningClaim) {
                try {
                  const bountyData = await publicClient.readContract({
                    address: contractAddress,
                    abi: contracts.abis.SimpleBounty,
                    functionName: 'getBounty',
                    args: [BigInt(event.tokenId)],
                  });
                  if (bountyData && bountyData[3]) {
                    fulfilled.winningClaim = bountyData[3];
                  }
                } catch (err) {
                  console.warn(`[Indexer] Could not read winningClaim for bounty ${event.tokenId}:`, err);
                }
              }
            }
            break;
        }
      }

      // Yield state update after processing this block
      const blockTime = performance.now() - blockStart;
      if (blockTime > 100) {
        console.log(`[Indexer] Slow block fetch: block ${nextBlock} took ${blockTime.toFixed(2)}ms (${blockEvents.length} events)`);
      }
      
      yield {
        bounties: Array.from(bounties.values()),
        claims: Object.fromEntries(claims),
        updates: Object.fromEntries(updates),
      };

      // Get next block from BlockPointer event
      if (blockData.blockPointerEvent) {
        const previousBlock = Number(blockData.blockPointerEvent.args.previousBlock);
        nextBlock = previousBlock;
      } else {
        // No BlockPointer event means we've reached the end
        break;
      }
    }
    
    // Read winningClaim for all fulfilled bounties that don't have it yet
    const fulfilledBounties = Array.from(bounties.values()).filter(b => b.fulfilled && !b.winningClaim);
    if (fulfilledBounties.length > 0) {
      console.log(`[Indexer] Reading winningClaim for ${fulfilledBounties.length} fulfilled bounties`);
      const readPromises = fulfilledBounties.map(async (bounty) => {
        try {
          const bountyData = await publicClient.readContract({
            address: contractAddress,
            abi: contracts.abis.SimpleBounty,
            functionName: 'getBounty',
            args: [BigInt(bounty.tokenId)],
          });
          if (bountyData && bountyData[3]) {
            bounty.winningClaim = bountyData[3];
          }
        } catch (err) {
          console.warn(`[Indexer] Could not read winningClaim for bounty ${bounty.tokenId}:`, err);
        }
      });
      await Promise.all(readPromises);
    }
    
    // Final yield with all updates (including winningClaim)
    const finalBounties = Array.from(bounties.values());
    const fulfilledCount = finalBounties.filter(b => b.fulfilled).length;
    console.log(`[Indexer] Final state: ${finalBounties.length} bounties, ${fulfilledCount} fulfilled`);
    
    const totalTime = performance.now() - startTime;
    console.log(`[Indexer] Completed indexing: ${eventCount} events in ${totalTime.toFixed(2)}ms (avg ${(totalTime / Math.max(eventCount, 1)).toFixed(2)}ms/event)`);
    
    // Yield final state one more time with all winningClaim values
    yield {
      bounties: finalBounties,
      claims: Object.fromEntries(claims),
      updates: Object.fromEntries(updates),
    };
  } catch (error) {
    console.error('Error indexing contract events:', error);
    throw error;
  }
}

/**
 * Get new events from a specific block range and apply them to existing state
 * @param {Object} publicClient - Viem public client
 * @param {string} contractAddress - SimpleBounty contract address
 * @param {number} fromBlock - Starting block (inclusive)
 * @param {number} toBlock - Ending block (inclusive)
 * @param {Object} existingState - Existing state with bounties and claims
 * @returns {Object} Updated state with new events applied
 */
export async function getNewEventsInRange(publicClient, contractAddress, fromBlock, toBlock, existingState = { bounties: [], claims: {}, updates: {} }) {
  if (fromBlock > toBlock || fromBlock === 0) {
    return existingState;
  }

  try {
    // Get all events in the range
    const logs = await publicClient.getLogs({
      address: contractAddress,
      fromBlock: BigInt(fromBlock),
      toBlock: BigInt(toBlock),
    });

    // Convert existing state to Maps for easier manipulation
    const bounties = new Map((existingState.bounties || []).map(b => [b.tokenId, { ...b }]));
    const claims = new Map();
    const updates = new Map();

    // Initialize claims map from existing state
    Object.entries(existingState.claims || {}).forEach(([tokenId, claimList]) => {
      claims.set(Number(tokenId), [...claimList]);
    });

    // Initialize updates map from existing state
    Object.entries(existingState.updates || {}).forEach(([tokenId, updateList]) => {
      updates.set(Number(tokenId), [...updateList]);
    });

    // Process new events
    for (const event of logs) {
      if (!event.topics || event.topics.length === 0) {
        continue;
      }

      try {
        const decoded = decodeEventLog({
          abi: contracts.abis.SimpleBounty,
          data: event.data,
          topics: event.topics,
        });

        const parsed = parseEvent({
          eventName: decoded.eventName,
          args: decoded.args,
          blockNumber: Number(event.blockNumber),
          transactionHash: event.transactionHash,
        });

        // Apply event to state
        switch (parsed.type) {
          case 'BountyCreated':
            bounties.set(parsed.tokenId, {
              tokenId: parsed.tokenId,
              data: parsed.data,
              tokenAddr: parsed.tokenAddr,
              amount: parsed.amount,
              creator: parsed.creator,
              createdAt: parsed.blockNumber,
              lastUpdated: parsed.blockNumber,
            });
            break;

          case 'BountyToppedUp':
            const toppedUp = bounties.get(parsed.tokenId);
            if (toppedUp) {
              toppedUp.amount = (BigInt(toppedUp.amount) + BigInt(parsed.amount)).toString();
              // Only update lastUpdated if this is a newer event
              if (!toppedUp.lastUpdated || parsed.blockNumber > toppedUp.lastUpdated) {
                toppedUp.lastUpdated = parsed.blockNumber;
              }
            }
            break;

          case 'BountyUpdated':
            // Store update history
            if (!updates.has(parsed.tokenId)) {
              updates.set(parsed.tokenId, []);
            }
            updates.get(parsed.tokenId).push({
              newData: parsed.newData,
              blockNumber: parsed.blockNumber,
              transactionHash: parsed.transactionHash,
            });

            let updated = bounties.get(parsed.tokenId);
            if (!updated) {
              // Bounty doesn't exist yet, create it with updated data
              console.log(`[Indexer] Bounty updated (creating): tokenId=${parsed.tokenId}, newData=${parsed.newData}, block=${parsed.blockNumber}`);
              updated = {
                tokenId: parsed.tokenId,
                data: parsed.newData,
                lastUpdated: parsed.blockNumber,
                // Other fields will be filled in by BountyCreated when processed
              };
              bounties.set(parsed.tokenId, updated);
            } else {
              // Only update data if this is a newer event (don't overwrite newer data with older data)
              if (!updated.lastUpdated || parsed.blockNumber > updated.lastUpdated) {
                updated.data = parsed.newData;
                updated.lastUpdated = parsed.blockNumber;
              }
            }
            break;

          case 'ClaimAttempted':
            if (!claims.has(parsed.tokenId)) {
              claims.set(parsed.tokenId, []);
            }
            // Check if claim already exists (avoid duplicates)
            const existingClaims = claims.get(parsed.tokenId);
            const claimExists = existingClaims.some(c => c.transactionHash === parsed.transactionHash);
            if (!claimExists) {
              claims.get(parsed.tokenId).push({
                claimant: parsed.claimant,
                claimData: parsed.claimData,
                blockNumber: parsed.blockNumber,
                transactionHash: parsed.transactionHash,
              });
            }
            break;

          case 'ClaimFulfilled':
            let fulfilled = bounties.get(parsed.tokenId);
            if (!fulfilled) {
              // Bounty doesn't exist in Map yet - read from contract to create it
              console.warn(`[Indexer] ClaimFulfilled for tokenId ${parsed.tokenId} but bounty not in Map (getNewEventsInRange). Reading from contract...`);
              try {
                const bountyData = await publicClient.readContract({
                  address: contractAddress,
                  abi: contracts.abis.SimpleBounty,
                  functionName: 'getBounty',
                  args: [BigInt(parsed.tokenId)],
                });
                if (bountyData) {
                  // Create bounty entry from contract data
                  fulfilled = {
                    tokenId: parsed.tokenId,
                    data: bountyData[0],
                    tokenAddr: bountyData[1],
                    amount: bountyData[2].toString(),
                    winningClaim: bountyData[3],
                    fulfilled: true,
                    winner: parsed.winner,
                    fulfilledAt: parsed.blockNumber,
                    // We don't have creator or createdAt from getBounty, so leave them undefined
                  };
                  bounties.set(parsed.tokenId, fulfilled);
                  console.log(`[Indexer] Created bounty ${parsed.tokenId} from contract data (fulfilled)`);
                }
              } catch (err) {
                console.error(`[Indexer] Could not read bounty ${parsed.tokenId} from contract:`, err);
              }
            }
            
            if (fulfilled) {
              fulfilled.fulfilled = true;
              fulfilled.winner = parsed.winner;
              fulfilled.fulfilledAt = parsed.blockNumber;
              // Read winningClaim from contract if not already set
              if (!fulfilled.winningClaim) {
                try {
                  const bountyData = await publicClient.readContract({
                    address: contractAddress,
                    abi: contracts.abis.SimpleBounty,
                    functionName: 'getBounty',
                    args: [BigInt(parsed.tokenId)],
                  });
                  if (bountyData && bountyData[3]) {
                    fulfilled.winningClaim = bountyData[3];
                  }
                } catch (err) {
                  console.warn(`[Indexer] Could not read winningClaim for bounty ${parsed.tokenId}:`, err);
                }
              }
            }
            break;
        }
      } catch (err) {
        // Skip events that can't be decoded
      }
    }

    // Read winningClaim for all fulfilled bounties that don't have it yet
    const fulfilledBounties = Array.from(bounties.values()).filter(b => b.fulfilled && !b.winningClaim);
    if (fulfilledBounties.length > 0) {
      console.log(`[Indexer] Reading winningClaim for ${fulfilledBounties.length} fulfilled bounties in range`);
      const readPromises = fulfilledBounties.map(async (bounty) => {
        try {
          const bountyData = await publicClient.readContract({
            address: contractAddress,
            abi: contracts.abis.SimpleBounty,
            functionName: 'getBounty',
            args: [BigInt(bounty.tokenId)],
          });
          if (bountyData && bountyData[3]) {
            bounty.winningClaim = bountyData[3];
          }
        } catch (err) {
          console.warn(`[Indexer] Could not read winningClaim for bounty ${bounty.tokenId}:`, err);
        }
      });
      await Promise.all(readPromises);
    }

    return {
      bounties: Array.from(bounties.values()),
      claims: Object.fromEntries(claims),
      updates: Object.fromEntries(updates),
    };
  } catch (error) {
    console.error('Error getting new events in range:', error);
    return existingState;
  }
}

