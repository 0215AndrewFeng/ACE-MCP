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

/** Min-heap: smallest distance at top (for candidates) */
class MinHeap {
  private readonly data: Array<{ id: string; distance: number }> = [];

  get size(): number { return this.data.length; }
  get isEmpty(): boolean { return this.data.length === 0; }

  peek(): { id: string; distance: number } | undefined { return this.data[0]; }

  push(item: { id: string; distance: number }): void {
    this.data.push(item);
    this.bubbleUp(this.data.length - 1);
  }

  pop(): { id: string; distance: number } {
    const top = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  toArray(): Array<{ id: string; distance: number }> {
    return [...this.data].sort((a, b) => a.distance - b.distance);
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.data[i].distance >= this.data[parent].distance) break;
      [this.data[i], this.data[parent]] = [this.data[parent], this.data[i]];
      i = parent;
    }
  }

  private sinkDown(i: number): void {
    const n = this.data.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.data[left].distance < this.data[smallest].distance) smallest = left;
      if (right < n && this.data[right].distance < this.data[smallest].distance) smallest = right;
      if (smallest === i) break;
      [this.data[i], this.data[smallest]] = [this.data[smallest], this.data[i]];
      i = smallest;
    }
  }
}

/** Max-heap: largest distance at top (for results — pop farthest to evict) */
class MaxHeap {
  private readonly data: Array<{ id: string; distance: number }> = [];

  get size(): number { return this.data.length; }
  get isEmpty(): boolean { return this.data.length === 0; }

  peek(): { id: string; distance: number } | undefined { return this.data[0]; }

  push(item: { id: string; distance: number }): void {
    this.data.push(item);
    this.bubbleUp(this.data.length - 1);
  }

  pop(): { id: string; distance: number } {
    const top = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  toArray(): Array<{ id: string; distance: number }> {
    return [...this.data].sort((a, b) => a.distance - b.distance);
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.data[i].distance <= this.data[parent].distance) break;
      [this.data[i], this.data[parent]] = [this.data[parent], this.data[i]];
      i = parent;
    }
  }

  private sinkDown(i: number): void {
    const n = this.data.length;
    while (true) {
      let largest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.data[left].distance > this.data[largest].distance) largest = left;
      if (right < n && this.data[right].distance > this.data[largest].distance) largest = right;
      if (largest === i) break;
      [this.data[i], this.data[largest]] = [this.data[largest], this.data[i]];
      i = largest;
    }
  }
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
    const MAGIC = 0x484e5357; // "HNSW"
    const VERSION = 1;
    const numNodes = this.nodes.size;
    const dim = this.config.dimension;

    // Pre-calculate buffer size
    // Header: magic(4) + version(2) + numNodes(4) + dim(4) + efConstruction(4) + efSearch(4) + m(4) + mL(8) + maxLevel(4) + entryPointId
    let headerSize = 4 + 2 + 4 + 4 + 4 + 4 + 4 + 8 + 4;
    const entryId = this.entryPointId ?? "";
    headerSize += 2 + entryId.length; // idLen + id

    // Per node: idLen(2) + id + level(2) + numLevels(2) + [level(2) + numNeighbors(2) + neighborIds...] + vector(dim*4)
    let nodesSize = 0;
    for (const [id, node] of this.nodes) {
      let nodeSize = 2 + id.length + 2 + 2; // idLen + id + level + numLevels
      for (const [, neighborSet] of node.neighbors) {
        nodeSize += 2 + 2; // level + numNeighbors
        for (const neighborId of neighborSet) {
          nodeSize += 2 + neighborId.length; // idLen + id
        }
      }
      nodeSize += dim * 4; // vector as Float32
      nodesSize += nodeSize;
    }

    const totalSize = headerSize + nodesSize;
    const buf = Buffer.alloc(totalSize);
    let offset = 0;

    // Write header
    buf.writeUInt32BE(MAGIC, offset); offset += 4;
    buf.writeUInt16BE(VERSION, offset); offset += 2;
    buf.writeUInt32BE(numNodes, offset); offset += 4;
    buf.writeUInt32BE(dim, offset); offset += 4;
    buf.writeUInt32BE(this.config.efConstruction, offset); offset += 4;
    buf.writeUInt32BE(this.config.efSearch, offset); offset += 4;
    buf.writeUInt32BE(this.config.m, offset); offset += 4;
    buf.writeDoubleBE(this.config.mL, offset); offset += 8;
    buf.writeUInt32BE(this.maxLevel, offset); offset += 4;
    // entryPointId
    buf.writeUInt16BE(entryId.length, offset); offset += 2;
    buf.write(entryId, offset, "utf-8"); offset += entryId.length;

    // Write nodes
    for (const [id, node] of this.nodes) {
      buf.writeUInt16BE(id.length, offset); offset += 2;
      buf.write(id, offset, "utf-8"); offset += id.length;
      buf.writeUInt16BE(node.level, offset); offset += 2;
      buf.writeUInt16BE(node.neighbors.size, offset); offset += 2;
      for (const [level, neighborSet] of node.neighbors) {
        buf.writeUInt16BE(level, offset); offset += 2;
        buf.writeUInt16BE(neighborSet.size, offset); offset += 2;
        for (const neighborId of neighborSet) {
          buf.writeUInt16BE(neighborId.length, offset); offset += 2;
          buf.write(neighborId, offset, "utf-8"); offset += neighborId.length;
        }
      }
      // Write vector as Float32
      const vecBuf = Buffer.from(node.vector.buffer, node.vector.byteOffset, dim * 4);
      vecBuf.copy(buf, offset); offset += dim * 4;
    }

    return buf.subarray(0, offset);
  }

  /**
   * Deserialize index from Buffer
   */
  static deserialize(buffer: Buffer): HnswIndex {
    // Try binary format first (magic = "HNSW")
    if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0x484e5357) {
      return HnswIndex.deserializeBinary(buffer);
    }
    // Fallback to legacy JSON format
    return HnswIndex.deserializeJson(buffer);
  }

  private static deserializeBinary(buffer: Buffer): HnswIndex {
    let offset = 0;
    const magic = buffer.readUInt32BE(offset); offset += 4;
    if (magic !== 0x484e5357) throw new Error("Invalid HNSW binary magic");
    const version = buffer.readUInt16BE(offset); offset += 2;
    if (version !== 1) throw new Error(`Unsupported HNSW binary version: ${version}`);
    const numNodes = buffer.readUInt32BE(offset); offset += 4;
    const dimension = buffer.readUInt32BE(offset); offset += 4;
    const efConstruction = buffer.readUInt32BE(offset); offset += 4;
    const efSearch = buffer.readUInt32BE(offset); offset += 4;
    const m = buffer.readUInt32BE(offset); offset += 4;
    const mL = buffer.readDoubleBE(offset); offset += 8;
    const maxLevel = buffer.readUInt32BE(offset); offset += 4;
    const entryIdLen = buffer.readUInt16BE(offset); offset += 2;
    const entryId = buffer.toString("utf-8", offset, offset + entryIdLen); offset += entryIdLen;

    const index = new HnswIndex({ dimension, maxElements: numNodes, efConstruction, efSearch, m, mL });
    index.maxLevel = maxLevel;
    index.entryPointId = entryId || null;

    for (let i = 0; i < numNodes; i++) {
      const idLen = buffer.readUInt16BE(offset); offset += 2;
      const id = buffer.toString("utf-8", offset, offset + idLen); offset += idLen;
      const level = buffer.readUInt16BE(offset); offset += 2;
      const numLevels = buffer.readUInt16BE(offset); offset += 2;
      const neighbors = new Map<number, Set<string>>();
      for (let l = 0; l < numLevels; l++) {
        const lvl = buffer.readUInt16BE(offset); offset += 2;
        const numNeighbors = buffer.readUInt16BE(offset); offset += 2;
        const neighborSet = new Set<string>();
        for (let n = 0; n < numNeighbors; n++) {
          const nIdLen = buffer.readUInt16BE(offset); offset += 2;
          const nId = buffer.toString("utf-8", offset, offset + nIdLen); offset += nIdLen;
          neighborSet.add(nId);
        }
        neighbors.set(lvl, neighborSet);
      }
      // Read vector
      const vector = new Float32Array(dimension);
      const vecBuf = buffer.subarray(offset, offset + dimension * 4);
      for (let d = 0; d < dimension; d++) {
        vector[d] = vecBuf.readFloatLE(d * 4);
      }
      offset += dimension * 4;

      index.nodes.set(id, { id, vector, level, neighbors });
    }

    return index;
  }

  private static deserializeJson(buffer: Buffer): HnswIndex {
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

    const candidates = new MinHeap();
    candidates.push({ id: startId, distance: startDist });
    const results = new MaxHeap();
    results.push({ id: startId, distance: startDist });

    while (!candidates.isEmpty) {
      const current = candidates.pop();

      // If closest candidate is farther than farthest result, stop
      if (results.size >= ef && current.distance > results.peek()!.distance) {
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
        if (results.size < ef || dist < results.peek()!.distance) {
          candidates.push({ id: neighborId, distance: dist });
          results.push({ id: neighborId, distance: dist });
          if (results.size > ef) {
            results.pop();
          }
        }
      }
    }

    return results.toArray();
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
