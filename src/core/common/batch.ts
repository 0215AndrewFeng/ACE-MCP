export async function mapInBatches<T, R>(
  items: readonly T[],
  batchSize: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const normalizedBatchSize = Math.max(1, Math.trunc(batchSize));
  const results: R[] = [];

  for (let start = 0; start < items.length; start += normalizedBatchSize) {
    const batch = items.slice(start, start + normalizedBatchSize);
    const batchResults = await Promise.all(batch.map((item, offset) => mapper(item, start + offset)));
    results.push(...batchResults);
  }

  return results;
}
