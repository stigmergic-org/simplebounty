import React, { createContext, useContext } from 'react';
import { useBounties } from '../hooks/useBounties';

const BountiesContext = createContext(null);

/**
 * Provider that shares bounties data across all components
 * This ensures useBounties is only called once, preventing duplicate indexing
 */
export function BountiesProvider({ children }) {
  const bountiesData = useBounties();

  return (
    <BountiesContext.Provider value={bountiesData}>
      {children}
    </BountiesContext.Provider>
  );
}

/**
 * Hook to access bounties data from context
 * Use this instead of calling useBounties directly
 */
export function useBountiesContext() {
  const context = useContext(BountiesContext);
  if (!context) {
    throw new Error('useBountiesContext must be used within BountiesProvider');
  }
  return context;
}

