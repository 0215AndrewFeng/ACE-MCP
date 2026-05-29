/**
 * HNSW (Hierarchical Navigable Small World) Index
 * Pure JavaScript implementation for approximate nearest neighbor search
 *
 * v4.4.2: ANN vector search to replace brute-force O(n) cosine similarity
 */

export interface HnswIndexConfig {
  dimension: number;
  maxElements: number;
  efConstruction: number;  // Construction-time neighbors, default 200
  efSearch: number;        // Search-time neighbors, default 50
  m: number;               // Max edges per node per layer, default 16
  mL?: number;             // Level multiplier, default 1/ln(m)
}

interface HnswNode {
  id: string;
  vector: Float32Array;
  level: number;
  neighbors: Map<number, Set<string>>;  // level -> neighbor ids
}

export interface HnswSearchResult {
  id: string;
  distance: number;
}

/**
 * HNSW Index for approximate nearest neighbor search
 *
 * Key features:
 * - Multi-layer graph structure with exponentially decreasing node counts
 * - O(log n) search complexity
 * - Cosine distance (1 - cosine_similarity)
 */
export class HnswIndex {
  private readonly config: Required<HnswIndexConfig>;
  private readonly nodes: Map<string, HnswNode> = new Map();
  private entryPointId: string | null = null;
  private maxLevel = 0;

  constructor(config: HnswIndexConfig) {
    this.config = {
      dimension: config.dimension,
      maxElements: config.maxElements,
      efConstruction: config.efConstruction ?? 200,
      efSearch: config.efSearch ?? 50,
      m: config.m ?? 16,
      mL: config.mL ?? 1 / Math.log(config.m ?? 16),
    };
  }

  /**
   * Get index configuration
   */
  getConfig(): Required<HnswIndexConfig> {
    return { ...this.config };
  }

  /**
   * Get number of elements in the index
   */
  size(): number {
    return this.nodes.size;
  }

  /**
   * Check if index is empty
   */
  isEmpty(): boolean {
    return this.nodes.size === 0;
  }

  /**
   * Add a single vector to the index
   */
  add(id: string, vector: number[]): void {
    if (this.nodes.has(id)) {
      // Update existing node
      const node = this.nodes.get(id)!;
      node.vector = new Float32Array(vector);
      return;
    }

    if (this.nodes.size >= this.config.maxElements) {
      throw new Error(`HNSW index is full (max ${this.config.maxElements} elements)`);
    }

    const level = this.randomLevel();
    const node: HnswNode = {
      id,
      vector: new Float32Array(vector),
      level,
      neighbors: new Map(),
    };

    // Initialize neighbor sets for each level
    for (let l = 0; l <= level; l++) {
      node.neighbors.set(l, new Set());
    }

    this.nodes.set(id, node);

    if (this.entryPointId === null) {
      // First node
      this.entryPointId = id;
      this.maxLevel = level;
      return;
    }

    let currentId = this.entryPointId;

    // Search from top level down to node's level
    for (let l = this.maxLevel; l > level; l--) {
      currentId = this.greedySearch(node.vector, currentId, l);
    }

    // Insert node at each layer from node's level down to 0
    for (let l = Math.min(level, this.maxLevel); l >= 0; l--) {
      const neighbors = this.searchLayer(node.vector, currentId, this.config.efConstruction, l);
      this.selectAndConnectNeighbors(id, neighbors, l);

      if (neighbors.length > 0) {
        currentId = neighbors[0].id;
      }
    }

    // Update entry point if new node has higher level
    if (level > this.maxLevel) {
      this.maxLevel = level;
      this.entryPointId = id;
    }
  }

  /**
   * Add multiple vectors in batch
   */
  addBatch(items: Array<{ id: string; vector: number[] }>): void {
    for (const item of items) {
      this.add(item.id, item.vector);
    }
  }

  /**
   * Search for k nearest neighbors
   */
  search(query: number[], k: number): HnswSearchResult[] {
    if (this.entryPointId === null) {
      return [];
    }

    const queryVec = new Float32Array(query);
    let currentId = this.entryPointId;

    // Search from top level down to level 1
    for (let l = this.maxLevel; l > 0; l--) {
      currentId = this.greedySearch(queryVec, currentId, l);
    }

    // Search layer 0 with ef candidates
    const ef = Math.max(k, this.config.efSearch);
    const candidates = this.searchLayer(queryVec, currentId, ef, 0);

    // Return top k
    return candidates.slice(0, k).map(c => ({
      id: c.id,
      distance: c.distance,
    }));
  }

  /**
   * Remove a vector from the index
   * Note: This is a soft delete that may leave graph inconsistent
   * Full rebuild recommended after many deletions
   */
  remove(id: string): boolean {
    const node = this.nodes.get(id);
    if (!node) {
      return false;
    }

    // Remove edges from neighbors
    for (let l = 0; l <= node.level; l++) {
      const neighbors = node.neighbors.get(l);
      if (neighbors) {
        for (const neighborId of neighbors) {
          const neighbor = this.nodes.get(neighborId);
          if (neighbor) {
            const neighborSet = neighbor.neighbors.get(l);
            if (neighborSet) {
              neighborSet.delete(id);
            }
          }
        }
      }
    }

    this.nodes.delete(id);

    // Update entry point if necessary
    if (this.entryPointId === id) {
      if (this.nodes.size === 0) {
        this.entryPointId = null;
        this.maxLevel = 0;
      } else {
        // Find new entry point (highest level node)
        let maxLevel = 0;
        let newEntryId: string | null = null;
        for (const [nodeId, n] of this.nodes) {
          if (n.level > maxLevel) {
            maxLevel = n.level;
            newEntryId = nodeId;
          }
        }
        this.entryPointId = newEntryId;
        this.maxLevel = maxLevel;
      }
    }

    return true;
  }

  /**
   * Serialize index to Buffer for persistence
   */
  serialize(): Buffer {
    const data: {
      config: Required<HnswIndexConfig>;
      entryPointId: string | null;
      maxLevel: number;
      nodes: Array<{
        id: string;
        vector: number[];
        level: number;
        neighbors: Array<[number, string[]]>;
      }>;
    } = {
      config: this.config,
      entryPointId: this.entryPointId,
      maxLevel: this.maxLevel,
      nodes: [],
    };

    for (const [id, node] of this.nodes) {
      const neighbors: Array<[number, string[]]> = [];
      for (const [level, neighborSet] of node.neighbors) {
        neighbors.push([level, [...neighborSet]]);
      }
      data.nodes.push({
        id,
        vector: [...node.vector],
        level: node.level,
        neighbors,
      });
    }

    return Buffer.from(JSON.stringify(data), "utf-8");
  }

  /**
   * Deserialize index from Buffer
   */
  static deserialize(buffer: Buffer): HnswIndex {
    const data = JSON.parse(buffer.toString("utf-8")) as {
      config: Required<HnswIndexConfig>;
      entryPointId: string | null;
      maxLevel: number;
      nodes: Array<{
        id: string;
        vector: number[];
        level: number;
        neighbors: Array<[number, string[]]>;
      }>;
    };

    const index = new HnswIndex(data.config);
    index.entryPointId = data.entryPointId;
    index.maxLevel = data.maxLevel;

    for (const nodeData of data.nodes) {
      const neighbors = new Map<number, Set<string>>();
      for (const [level, neighborIds] of nodeData.neighbors) {
        neighbors.set(level, new Set(neighborIds));
      }
      index.nodes.set(nodeData.id, {
        id: nodeData.id,
        vector: new Float32Array(nodeData.vector),
        level: nodeData.level,
        neighbors,
      });
    }

    return index;
  }

  // === Private methods ===

  /**
   * Generate random level for new node using exponential distribution
   */
  private randomLevel(): number {
    let level = 0;
    while (Math.random() < this.config.mL && level < 32) {
      level++;
    }
    return level;
  }

  /**
   * Compute cosine distance (1 - cosine_similarity)
   */
  private cosineDistance(a: Float32Array, b: Float32Array): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    const similarity = denom === 0 ? 0 : dotProduct / denom;
    return 1 - similarity;  // Distance = 1 - similarity
  }

  /**
   * Greedy search to find closest node at a given level
   */
  private greedySearch(query: Float32Array, startId: string, level: number): string {
    let currentId = startId;
    let currentNode = this.nodes.get(currentId)!;
    let currentDist = this.cosineDistance(query, currentNode.vector);

    let improved = true;
    while (improved) {
      improved = false;
      const neighbors = currentNode.neighbors.get(level);
      if (!neighbors) continue;

      for (const neighborId of neighbors) {
        const neighbor = this.nodes.get(neighborId);
        if (!neighbor) continue;

        const dist = this.cosineDistance(query, neighbor.vector);
        if (dist < currentDist) {
          currentId = neighborId;
          currentNode = neighbor;
          currentDist = dist;
          improved = true;
        }
      }
    }

    return currentId;
  }

  /**
   * Search layer using beam search to find ef nearest neighbors
   */
  private searchLayer(
    query: Float32Array,
    startId: string,
    ef: number,
    level: number,
  ): Array<{ id: string; distance: number }> {
    const visited = new Set<string>([startId]);
    const startNode = this.nodes.get(startId)!;
    const startDist = this.cosineDistance(query, startNode.vector);

    // Candidates: min-heap by distance (closest first)
    const candidates: Array<{ id: string; distance: number }> = [
      { id: startId, distance: startDist },
    ];
    // Results: sorted by distance
    const results: Array<{ id: string; distance: number }> = [
      { id: startId, distance: startDist },
    ];

    while (candidates.length > 0) {
      // Get closest candidate
      candidates.sort((a, b) => a.distance - b.distance);
      const current = candidates.shift()!;

      // If closest candidate is farther than farthest result, stop
      if (results.length >= ef && current.distance > results[results.length - 1].distance) {
        break;
      }

      const currentNode = this.nodes.get(current.id);
      if (!currentNode) continue;

      const neighbors = currentNode.neighbors.get(level);
      if (!neighbors) continue;

      for (const neighborId of neighbors) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);

        const neighbor = this.nodes.get(neighborId);
        if (!neighbor) continue;

        const dist = this.cosineDistance(query, neighbor.vector);

        // Add to results if closer than farthest, or if results not full
        if (results.length < ef || dist < results[results.length - 1].distance) {
          candidates.push({ id: neighborId, distance: dist });
          results.push({ id: neighborId, distance: dist });
          results.sort((a, b) => a.distance - b.distance);
          if (results.length > ef) {
            results.pop();
          }
        }
      }
    }

    return results;
  }

  /**
   * Select neighbors and create bidirectional edges
   */
  private selectAndConnectNeighbors(
    nodeId: string,
    candidates: Array<{ id: string; distance: number }>,
    level: number,
  ): void {
    const node = this.nodes.get(nodeId)!;
    const maxNeighbors = level === 0 ? this.config.m * 2 : this.config.m;

    // Select top M neighbors
    const selectedNeighbors = candidates.slice(0, maxNeighbors);

    // Create edges from node to selected neighbors
    const nodeNeighbors = node.neighbors.get(level)!;
    for (const neighbor of selectedNeighbors) {
      nodeNeighbors.add(neighbor.id);
    }

    // Create edges from neighbors back to node (bidirectional)
    for (const { id: neighborId } of selectedNeighbors) {
      const neighbor = this.nodes.get(neighborId);
      if (!neighbor) continue;

      let neighborSet = neighbor.neighbors.get(level);
      if (!neighborSet) {
        neighborSet = new Set();
        neighbor.neighbors.set(level, neighborSet);
      }
      neighborSet.add(nodeId);

      // Prune if too many neighbors
      if (neighborSet.size > maxNeighbors) {
        this.pruneNeighbors(neighborId, level, maxNeighbors);
      }
    }
  }

  /**
   * Prune neighbors to keep only the closest ones
   */
  private pruneNeighbors(nodeId: string, level: number, maxNeighbors: number): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    const neighborSet = node.neighbors.get(level);
    if (!neighborSet || neighborSet.size <= maxNeighbors) return;

    // Calculate distances to all neighbors
    const distances: Array<{ id: string; distance: number }> = [];
    for (const neighborId of neighborSet) {
      const neighbor = this.nodes.get(neighborId);
      if (neighbor) {
        distances.push({
          id: neighborId,
          distance: this.cosineDistance(node.vector, neighbor.vector),
        });
      }
    }

    // Sort by distance and keep closest
    distances.sort((a, b) => a.distance - b.distance);
    const toRemove = distances.slice(maxNeighbors).map(d => d.id);

    for (const id of toRemove) {
      neighborSet.delete(id);
    }
  }
}
