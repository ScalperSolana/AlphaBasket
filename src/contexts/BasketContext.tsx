import React, { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import { BasketItem, BasketDraft, Outcome } from '@/types/basket.ts';
import { PolymarketMarket, OutcomeProbabilities } from '@/types/polymarket.ts';
import { getDraft, saveDraft, clearDraft } from '@/lib/basket-storage.ts';
import { normalizeWeights, createItemFromMarket } from '@/lib/basket-utils.ts';
import { getOutcomeProbabilities } from '@/lib/polymarket.ts';

interface BasketContextType {
  items: BasketItem[];
  name: string;
  description: string;
  tags: string[];
  addItem: (market: PolymarketMarket, outcome: Outcome) => void;
  removeItem: (marketId: string, outcome: Outcome) => void;
  updateWeight: (marketId: string, outcome: Outcome, weightBps: number) => void;
  setName: (name: string) => void;
  setDescription: (description: string) => void;
  setTags: (tags: string[]) => void;
  normalizeAllWeights: () => void;
  clearBasket: () => void;
  loadDraft: () => void;
  replaceDraft: (draft: BasketDraft) => void;
  hasItem: (marketId: string, outcome: Outcome) => boolean;
  getDraftData: () => BasketDraft;
  updateProbabilities: (probs: Map<string, OutcomeProbabilities>) => void;
}

const BasketContext = createContext<BasketContextType | undefined>(undefined);

// Export BasketContext for direct access if needed
export { BasketContext };

export function BasketProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<BasketItem[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState<string[]>([]);

  // Auto-save draft on changes
  useEffect(() => {
    if (items.length > 0 || name || description) {
      saveDraft({ items, name, description, tags });
    }
  }, [items, name, description, tags]);

  const loadDraft = useCallback(() => {
    const draft = getDraft();
    if (draft) {
      setItems(draft.items);
      setName(draft.name);
      setDescription(draft.description);
      setTags(draft.tags);
    }
  }, []);

  const replaceDraft = useCallback((draft: BasketDraft) => {
    setItems(draft.items);
    setName(draft.name);
    setDescription(draft.description);
    setTags(draft.tags);
    saveDraft(draft);
  }, []);

  useEffect(() => {
    loadDraft();
  }, [loadDraft]);

  const addItem = useCallback((market: PolymarketMarket, outcome: Outcome) => {
    setItems(prev => {
      // Check for duplicate
      const exists = prev.some(
        item => item.marketId === market.id && item.outcome === outcome
      );
      if (exists || prev.length >= 10) return prev;

      const newItem = createItemFromMarket(market, outcome, 0);
      const newItems = [...prev, newItem];
      
      // Auto-normalize weights
      return normalizeWeights(newItems);
    });
  }, []);

  const removeItem = useCallback((marketId: string, outcome: Outcome) => {
    setItems(prev => {
      const filtered = prev.filter(
        item => !(item.marketId === marketId && item.outcome === outcome)
      );
      return filtered.length > 0 ? normalizeWeights(filtered) : [];
    });
  }, []);

  const updateWeight = useCallback((marketId: string, outcome: Outcome, weightBps: number) => {
    setItems(prev => 
      prev.map(item => 
        item.marketId === marketId && item.outcome === outcome
          ? { ...item, weightBps: Math.max(0, Math.min(10000, weightBps)) }
          : item
      )
    );
  }, []);

  const normalizeAllWeights = useCallback(() => {
    setItems(prev => normalizeWeights(prev));
  }, []);

  const clearBasket = useCallback(() => {
    setItems([]);
    setName('');
    setDescription('');
    setTags([]);
    clearDraft();
  }, []);

  const hasItem = useCallback((marketId: string, outcome: Outcome) => {
    return items.some(item => item.marketId === marketId && item.outcome === outcome);
  }, [items]);

  const getDraftData = useCallback((): BasketDraft => {
    return { items, name, description, tags };
  }, [items, name, description, tags]);

  const updateProbabilities = useCallback((probs: Map<string, OutcomeProbabilities>) => {
    setItems(prev => 
      prev.map(item => {
        const marketProbs = probs.get(item.marketId);
        if (marketProbs) {
          return {
            ...item,
            currentProb: item.outcome === 'YES' ? marketProbs.YES : marketProbs.NO,
          };
        }
        return item;
      })
    );
  }, []);

  return (
    <BasketContext.Provider value={{
      items,
      name,
      description,
      tags,
      addItem,
      removeItem,
      updateWeight,
      setName,
      setDescription,
      setTags,
      normalizeAllWeights,
      clearBasket,
      loadDraft,
      replaceDraft,
      hasItem,
      getDraftData,
      updateProbabilities,
    }}>
      {children}
    </BasketContext.Provider>
  );
}

export function useBasket() {
  const context = useContext(BasketContext);
  if (!context) {
    throw new Error('useBasket must be used within a BasketProvider');
  }
  return context;
}
