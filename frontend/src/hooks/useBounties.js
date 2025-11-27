import { useState, useEffect, useCallback, useRef } from 'react';
import { usePublicClient } from 'wagmi';
import { useChainId } from './useChainId';
import { contracts } from '../config/contracts';
import { indexAllEvents } from '../utils/indexer';

/**
 * Hook to fetch all bounties using the ReverseIndexable pattern
 */
export function useBounties() {
  const publicClient = usePublicClient();
  const chainId = useChainId();
  const [bounties, setBounties] = useState([]);
  const [claims, setClaims] = useState({});
  const [updates, setUpdates] = useState({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const lastBlockPointerRef = useRef(0);
  const pollingIntervalRef = useRef(null);
  const isRefreshingRef = useRef(false);

  const contractAddress = contracts.deployments[chainId]?.SimpleBounty;

  const refreshBounties = useCallback(async (incremental = false) => {
    if (!publicClient || !contractAddress) {
      setIsLoading(false);
      return;
    }

    // Prevent concurrent refreshes
    if (isRefreshingRef.current) {
      return;
    }

    isRefreshingRef.current = true;

    try {
      // Get current block pointer
      const blockPointer = await publicClient.readContract({
        address: contractAddress,
        abi: contracts.abis.SimpleBounty,
        functionName: 'blockPointer',
      });
      const currentBlockPointer = Number(blockPointer);

      // If incremental and blockPointer hasn't changed, skip
      if (incremental && currentBlockPointer === lastBlockPointerRef.current) {
        return;
      }

      // For incremental updates, we need to do a full refresh to follow the reverse indexing chain
      // The reverse indexing pattern means we can't just get logs from a range - we need to follow the chain
      // So we'll do a full refresh but it should be fast since we're starting from the same point
      if (incremental && lastBlockPointerRef.current > 0) {
        // For now, skip incremental updates and just check if blockPointer changed
        // If it did, we'll need to do a full refresh to get all events correctly
        // This is safer than trying to do partial updates with the reverse indexing pattern
        if (currentBlockPointer === lastBlockPointerRef.current) {
          return;
        }
        // Block pointer changed, fall through to full refresh
        // But don't set loading to true for incremental updates to avoid UI flicker
      }

      // Full refresh (or incremental that needs full refresh due to reverse indexing)
      if (!incremental) {
        setIsLoading(true);
        setError(null);
      }

      let hasReceivedUpdate = false;
      
      // Update state incrementally as blocks are processed
      for await (const state of indexAllEvents(publicClient, contractAddress, chainId)) {
        // Update state after each block is processed
        setBounties(state.bounties);
        setClaims(state.claims);
        setUpdates(state.updates);
        
        // Set loading to false after first update so UI can show bounties as they load
        if (!hasReceivedUpdate) {
          if (!incremental) {
            setIsLoading(false);
          }
          hasReceivedUpdate = true;
        }
      }
      
      // Ensure loading is false when iteration completes
      if (!incremental) {
        setIsLoading(false);
      }
      lastBlockPointerRef.current = currentBlockPointer;
    } catch (err) {
      console.error('Error fetching bounties:', err);
      setError(err);
      setIsLoading(false);
    } finally {
      isRefreshingRef.current = false;
    }
  }, [publicClient, contractAddress, chainId]);

  // Initial load
  useEffect(() => {
    refreshBounties(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicClient, contractAddress, chainId]);

  // Set up polling for new events
  useEffect(() => {
    if (!publicClient || !contractAddress || isLoading) return;

    // Poll every 2 seconds for new events (reduced frequency to avoid issues)
    pollingIntervalRef.current = setInterval(() => {
      refreshBounties(true);
    }, 2000);

    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
    };
  }, [publicClient, contractAddress, isLoading, refreshBounties]);

  return {
    bounties,
    claims,
    updates,
    isLoading,
    error,
    refresh: () => refreshBounties(false),
  };
}

