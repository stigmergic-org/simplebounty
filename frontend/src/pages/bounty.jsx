import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router';
import { useAccount, usePublicClient, useEnsName } from 'wagmi';
import { useBounty } from '../hooks/useBounty';
import { useMakeClaim } from '../hooks/useMakeClaim';
import { useFulfillClaim } from '../hooks/useFulfillClaim';
import { useBountiesContext } from '../contexts/BountiesContext';
import WalletInfo from '../components/WalletInfo';
import LoadingSpinner from '../components/LoadingSpinner';
import TransactionStatus from '../components/TransactionStatus';
import AddressDisplay from '../components/AddressDisplay';
import Avatar from '../components/Avatar';
import Username from '../components/Username';
import { formatEther, formatUnits } from 'viem';
import { fetchTextData } from '../utils/dservice-upload';
import { parseMarkdownWithFrontmatter, MarkdownRenderer } from '../utils/markdown';
import { useChainId } from '../hooks/useChainId';
import { getTokenByAddress } from '../config/tokens';

// ERC20 ABI for fetching token metadata
const erc20Abi = [
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    name: 'symbol',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
];

const Bounty = () => {
  const { tokenId } = useParams();
  const navigate = useNavigate();
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const chainId = useChainId();
  const { bounty, claims, isLoading, error } = useBounty(tokenId);
  const { makeClaim, hash: claimHash, isPending: isClaimPending, isConfirming: isClaimConfirming, isSuccess: isClaimSuccess, error: claimError, reset: resetClaim } = useMakeClaim();
  const { fulfillClaim, hash: fulfillHash, isPending: isFulfillPending, isConfirming: isFulfillConfirming, isSuccess: isFulfillSuccess, error: fulfillError, reset: resetFulfill } = useFulfillClaim();

  const [claimData, setClaimData] = useState('');
  const [selectedClaim, setSelectedClaim] = useState(null);
  const [customTokenMetadata, setCustomTokenMetadata] = useState(null);
  const [descriptionText, setDescriptionText] = useState(null);
  const [descriptionTitle, setDescriptionTitle] = useState(null);
  const [descriptionLoading, setDescriptionLoading] = useState(false);
  const [descriptionError, setDescriptionError] = useState(null);
  const [claimTexts, setClaimTexts] = useState({});
  const [blockTimestamps, setBlockTimestamps] = useState({});
  const { refresh: refreshBounties } = useBountiesContext();

  // Helper function to check if bounty is fulfilled
  const isBountyFulfilled = (bounty) => {
    if (!bounty) return false;
    // Check both the fulfilled flag (from indexer) and winningClaim (from contract)
    const hasFulfilledFlag = bounty.fulfilled === true;
    const hasWinningClaim = bounty.winningClaim && 
      bounty.winningClaim !== '0x0000000000000000000000000000000000000000000000000000000000000000';
    return hasFulfilledFlag || hasWinningClaim;
  };

  const formatAmount = (amount, tokenAddr) => {
    if (tokenAddr === '0x0000000000000000000000000000000000000000' || !tokenAddr) {
      return `${formatEther(BigInt(amount))} ETH`;
    }

    // Look up token by address in config
    const token = getTokenByAddress(tokenAddr, chainId);
    if (token) {
      const formattedAmount = formatUnits(BigInt(amount), token.decimals);
      return `${formattedAmount} ${token.symbol}`;
    }

    // Check if we have fetched metadata for this custom token
    if (customTokenMetadata) {
      const formattedAmount = formatUnits(BigInt(amount), customTokenMetadata.decimals);
      return `${formattedAmount} ${customTokenMetadata.symbol}`;
    }

    // Fallback while loading or if fetch failed
    return `${amount} tokens`;
  };

  const formatAddress = (addr) => {
    if (!addr) return '';
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  // Format timestamp from block number
  const formatTimestamp = (timestamp) => {
    if (!timestamp) return '';
    const date = new Date(Number(timestamp) * 1000);
    return date.toLocaleString();
  };

  // Format relative time
  const formatRelativeTime = (timestamp) => {
    if (!timestamp) return '';
    const date = new Date(Number(timestamp) * 1000);
    const now = new Date();
    const diffMs = now - date;
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSecs < 60) return 'just now';
    if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
    if (diffDays < 7) return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
    return date.toLocaleDateString();
  };

  // Fetch block timestamps
  useEffect(() => {
    if (!publicClient || !bounty || !claims) return;

    const fetchTimestamps = async () => {
      const timestamps = {};
      const blocksToFetch = new Set();

      // Add bounty creation block
      if (bounty.createdAt) {
        blocksToFetch.add(bounty.createdAt);
      }

      // Add claim blocks
      claims.forEach(claim => {
        if (claim.blockNumber) {
          blocksToFetch.add(claim.blockNumber);
        }
      });

      // Fetch timestamps for all blocks that we don't already have
      for (const blockNumber of blocksToFetch) {
        if (!blockTimestamps[blockNumber]) {
          try {
            const block = await publicClient.getBlock({ blockNumber: BigInt(blockNumber) });
            timestamps[blockNumber] = block.timestamp.toString();
          } catch (err) {
            console.error(`Error fetching block ${blockNumber}:`, err);
          }
        }
      }

      if (Object.keys(timestamps).length > 0) {
        setBlockTimestamps(prev => ({ ...prev, ...timestamps }));
      }
    };

    fetchTimestamps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicClient, bounty?.createdAt, claims]);

  // Fetch token metadata for custom tokens
  useEffect(() => {
    if (!bounty?.tokenAddr || !publicClient || !chainId) return;

    const tokenAddr = bounty.tokenAddr;
    if (tokenAddr === '0x0000000000000000000000000000000000000000' || getTokenByAddress(tokenAddr, chainId)) {
      // Not a custom token
      return;
    }

    const fetchTokenMetadata = async () => {
      try {
        const [decimals, symbol] = await Promise.all([
          publicClient.readContract({
            address: tokenAddr,
            abi: erc20Abi,
            functionName: 'decimals',
          }),
          publicClient.readContract({
            address: tokenAddr,
            abi: erc20Abi,
            functionName: 'symbol',
          }),
        ]);

        setCustomTokenMetadata({
          decimals: Number(decimals),
          symbol: String(symbol),
        });
      } catch (err) {
        console.error(`Error fetching metadata for token ${tokenAddr}:`, err);
        setCustomTokenMetadata({
          decimals: 18,
          symbol: 'UNKNOWN',
        });
      }
    };

    fetchTokenMetadata();
  }, [bounty?.tokenAddr, publicClient, chainId]);

  // Fetch description text from dservice
  useEffect(() => {
    if (!bounty?.data || !publicClient) return;
    
    const hash = bounty.data;
    if (!hash || hash === '0x0000000000000000000000000000000000000000000000000000000000000000') {
      setDescriptionText('No description');
      return;
    }

    setDescriptionLoading(true);
    setDescriptionError(null);
    
    fetchTextData(hash, publicClient)
      .then(text => {
        const { title, body } = parseMarkdownWithFrontmatter(text);
        setDescriptionTitle(title);
        setDescriptionText(body);
        setDescriptionLoading(false);
      })
      .catch(err => {
        console.error('Error fetching description:', err);
        setDescriptionError(err.message);
        setDescriptionLoading(false);
        // Fallback to showing hash
        setDescriptionText(`Error loading description: ${err.message}`);
        setDescriptionTitle(null);
      });
  }, [bounty?.data, publicClient]);

  // Fetch claim texts from dservice
  useEffect(() => {
    if (!claims || claims.length === 0 || !publicClient) return;

    const fetchClaimTexts = async () => {
      const texts = {};
      for (const claim of claims) {
        if (!claim.claimData || claim.claimData === '0x0000000000000000000000000000000000000000000000000000000000000000') {
          texts[claim.transactionHash] = 'No claim data';
          continue;
        }
        try {
          const text = await fetchTextData(claim.claimData, publicClient);
          texts[claim.transactionHash] = text;
        } catch (err) {
          console.error('Error fetching claim data:', err);
          texts[claim.transactionHash] = `Error loading claim: ${err.message}`;
        }
      }
      setClaimTexts(texts);
    };

    fetchClaimTexts();
  }, [claims, publicClient]);


  const handleMakeClaim = async () => {
    if (isBountyFulfilled(bounty)) {
      alert('This bounty has already been fulfilled');
      return;
    }
    if (!claimData.trim()) {
      alert('Please enter claim data');
      return;
    }
    try {
      await makeClaim(tokenId, claimData);
    } catch (err) {
      console.error('Error making claim:', err);
    }
  };

  const handleFulfillClaim = async () => {
    if (isBountyFulfilled(bounty)) {
      alert('This bounty has already been fulfilled');
      return;
    }
    if (!selectedClaim) {
      alert('Please select a claim to fulfill');
      return;
    }
    // Get the claim data for the selected claim
    const claim = claims.find(c => c.transactionHash === selectedClaim);
    if (!claim) {
      alert('Selected claim not found');
      return;
    }
    if (!claim.claimData) {
      alert('Selected claim has no claim data');
      return;
    }
    try {
      // Pass the claim data hash as winningClaim
      await fulfillClaim(tokenId, claim.claimant, claim.claimData);
      setSelectedClaim(null);
    } catch (err) {
      console.error('Error fulfilling claim:', err);
    }
  };

  const toggleClaimSelection = (transactionHash) => {
    // Prevent selection if bounty is fulfilled
    if (isBountyFulfilled(bounty)) return;
    // Single select: if already selected, deselect; otherwise select this one
    setSelectedClaim(selectedClaim === transactionHash ? null : transactionHash);
  };

  // Clear selected claim when bounty becomes fulfilled
  useEffect(() => {
    if (isBountyFulfilled(bounty) && selectedClaim) {
      setSelectedClaim(null);
    }
  }, [bounty, selectedClaim]);

  const isOwner = bounty && isConnected && address && bounty.creator?.toLowerCase() === address.toLowerCase();

  if (isLoading) {
    return (
      <div className="min-h-screen bg-base-100 p-4 sm:p-8">
        <div className="max-w-4xl mx-auto">
          <WalletInfo />
          <div className="flex justify-center items-center h-64">
            <LoadingSpinner />
          </div>
        </div>
      </div>
    );
  }

  if (error || !bounty) {
    return (
      <div className="min-h-screen bg-base-100 p-4 sm:p-8">
        <div className="max-w-4xl mx-auto">
          <WalletInfo />
          <div className="alert alert-error">
            <span>Bounty not found or error loading: {error?.message}</span>
          </div>
          <button onClick={() => navigate('/')} className="btn btn-outline mt-4">
            Back to Bounties
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-base-100 px-2 py-3 sm:p-4 sm:py-6 lg:p-8">
      <div className="max-w-6xl mx-auto">
        <WalletInfo />
        
        <button onClick={() => navigate('/')} className="btn btn-ghost btn-sm mb-3 sm:mb-4">
          ← Back to Bounties
        </button>

        <TransactionStatus
          status={isClaimPending || isClaimConfirming ? 'pending' : isClaimSuccess ? 'success' : claimError ? 'error' : null}
          hash={claimHash}
          error={claimError}
          isConfirmed={isClaimSuccess}
          reset={resetClaim}
          redirectPath={`/${tokenId}`}
          onSuccess={() => {
            setClaimData('');
            refreshBounties();
          }}
        />

        <TransactionStatus
          status={isFulfillPending || isFulfillConfirming ? 'pending' : isFulfillSuccess ? 'success' : fulfillError ? 'error' : null}
          hash={fulfillHash}
          error={fulfillError}
          isConfirmed={isFulfillSuccess}
          reset={resetFulfill}
          redirectPath={`/${tokenId}`}
          onSuccess={() => {
            setSelectedClaim(null);
            refreshBounties();
          }}
        />

        {/* Header */}
        <div className="mb-3 sm:mb-4">
          <div className="flex items-center justify-between mb-2">
            <h1 className="text-2xl sm:text-3xl font-semibold">
              {descriptionTitle || `Bounty #${bounty.tokenId}`}
            </h1>
            {isBountyFulfilled(bounty) && (
              <span className="badge badge-success text-xs sm:text-sm">Fulfilled</span>
            )}
          </div>
          {!descriptionTitle && (
            <div className="text-base-content/60 mb-2 text-sm sm:text-base">
              Bounty #{bounty.tokenId}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 sm:gap-4 text-xs sm:text-sm text-base-content/60">
            <span className="font-semibold text-primary text-base sm:text-lg">
              {formatAmount(bounty.amount, bounty.tokenAddr)}
            </span>
            {isBountyFulfilled(bounty) && bounty.winner && (
              <span>• Paid out</span>
            )}
            <span>• {claims.length} claim{claims.length !== 1 ? 's' : ''}</span>
          </div>
        </div>

        {/* Main Issue/Description - GitHub style */}
        <div className="border border-base-300 rounded-lg bg-base-100">
          <div className="flex gap-2 sm:gap-4 p-3 sm:p-4">
            <Avatar address={bounty.creator} size="md" />
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 mb-2">
                <Username address={bounty.creator} />
                <span className="text-xs sm:text-sm text-base-content/60">opened this bounty</span>
                {bounty.createdAt && blockTimestamps[bounty.createdAt] && (
                  <span className="text-xs sm:text-sm text-base-content/40">
                    • {formatRelativeTime(blockTimestamps[bounty.createdAt])}
                  </span>
                )}
              </div>
              <div className="prose prose-sm max-w-none">
                {descriptionLoading ? (
                  <div className="flex items-center gap-2 py-4">
                    <span className="loading loading-spinner loading-sm"></span>
                    <span className="text-base-content/60">Loading description...</span>
                  </div>
                ) : descriptionError ? (
                  <p className="text-error">{descriptionError}</p>
                ) : (
                  <MarkdownRenderer markdown={descriptionText || 'Loading...'} />
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Claims/Comments - GitHub style */}
        {claims.length > 0 && (
          <div className="mt-4 sm:mt-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-0 mb-3 sm:mb-4">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg sm:text-xl font-semibold">
                  {claims.length} {claims.length === 1 ? 'Claim' : 'Claims'}
                </h2>
                {isOwner && !isBountyFulfilled(bounty) && claims.length > 0 && !selectedClaim && (
                  <span className="text-xs sm:text-sm text-base-content/60">
                    Select a claim below to fulfill it
                  </span>
                )}
              </div>
              {isOwner && !isBountyFulfilled(bounty) && selectedClaim && (
                <button
                  onClick={handleFulfillClaim}
                  disabled={isFulfillPending}
                  className="btn btn-success btn-sm text-xs sm:text-sm"
                >
                  {isFulfillPending ? 'Processing...' : 'Fulfill Selected Claim'}
                </button>
              )}
            </div>
            <div className="border border-base-300 rounded-lg bg-base-100 divide-y divide-base-300">
              {claims.map((claim, idx) => {
                const isSelected = selectedClaim === claim.transactionHash;
                const fulfilled = isBountyFulfilled(bounty);
                // Check if this claim is the winner by comparing claimData with winningClaim
                const isWinner = fulfilled && 
                  bounty.winningClaim && 
                  bounty.winningClaim.toLowerCase() === claim.claimData?.toLowerCase();
                return (
                  <div
                    key={idx}
                    className={`${
                      isWinner
                        ? 'bg-success/10 border-l-4 border-l-success'
                        : isOwner && !fulfilled
                        ? isSelected
                          ? 'bg-primary/5 border-l-4 border-l-primary'
                          : 'hover:bg-base-200/50 cursor-pointer'
                        : ''
                    }`}
                    onClick={() => !fulfilled && isOwner && toggleClaimSelection(claim.transactionHash)}
                  >
                    <div className="flex gap-2 sm:gap-4 p-3 sm:p-4">
                      {isOwner && !fulfilled && (
                        <div className="pt-1">
                          <input
                            type="radio"
                            checked={isSelected}
                            onChange={() => toggleClaimSelection(claim.transactionHash)}
                            onClick={(e) => e.stopPropagation()}
                            className="radio radio-primary radio-sm"
                          />
                        </div>
                      )}
                      <Avatar address={claim.claimant} size="md" />
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 mb-2">
                          <Username address={claim.claimant} />
                          {isWinner ? (
                            <span className="text-xs sm:text-sm text-success font-semibold">
                              🏆 Winner
                            </span>
                          ) : (
                            <span className="text-xs sm:text-sm text-base-content/60">
                              commented
                            </span>
                          )}
                          {claim.blockNumber && blockTimestamps[claim.blockNumber] && (
                            <span className="text-xs sm:text-sm text-base-content/40" title={formatTimestamp(blockTimestamps[claim.blockNumber])}>
                              • {formatRelativeTime(blockTimestamps[claim.blockNumber])}
                            </span>
                          )}
                          {claim.blockNumber && !blockTimestamps[claim.blockNumber] && (
                            <span className="text-xs sm:text-sm text-base-content/40">
                              • Block {claim.blockNumber}
                            </span>
                          )}
                        </div>
                        <div className="prose prose-sm max-w-none">
                          {claimTexts[claim.transactionHash] ? (
                            <MarkdownRenderer markdown={claimTexts[claim.transactionHash]} />
                          ) : (
                            <span className="text-base-content/60 italic">Loading claim data...</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Make a Claim Form - GitHub style */}
        {!isBountyFulfilled(bounty) && (
          <div className="border border-base-300 rounded-lg bg-base-100 mt-4 sm:mt-6">
            <div className="p-3 sm:p-4">
              <h3 className="text-base sm:text-lg font-semibold mb-3 sm:mb-4">Add a claim</h3>
              <div className="space-y-3">
                <textarea
                  className="textarea textarea-bordered w-full min-h-[120px] resize-none"
                  placeholder="Explain how you completed the bounty..."
                  value={claimData}
                  onChange={(e) => setClaimData(e.target.value)}
                  rows={6}
                />
                <div className="flex items-center justify-between">
                  <div className="text-sm text-base-content/60">
                    {!isConnected && 'Connect your wallet to make a claim'}
                  </div>
                  <button
                    onClick={handleMakeClaim}
                    disabled={!isConnected || isClaimPending || !claimData.trim() || isBountyFulfilled(bounty)}
                    className="btn btn-primary"
                  >
                    {isClaimPending ? 'Submitting...' : 'Make Claim'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Bounty;

