import type { Store } from './store.js';
import type { Embedder } from './embedder.js';
import type { SearchResult } from './types.js';

export class Search {
  constructor(
    private store: Store,
    private embedder: Embedder,
  ) {}

  async semantic(query: string, limit = 20): Promise<SearchResult[]> {
    const queryEmbedding = await this.embedder.embed(query);
    return this.store.searchVector(queryEmbedding, limit);
  }

  fulltext(query: string, limit = 20): SearchResult[] {
    // Forward the limit: searchFullText applies LIMIT in SQL (default 20), so
    // calling it without `limit` capped results at 20 and the .slice(0, limit)
    // was a no-op for any limit > 20. Other callers (mcp, cli) forward it.
    return this.store.searchFullText(query, limit);
  }
}
