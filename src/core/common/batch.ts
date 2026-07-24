export async function mapInBatches<T, R>(
  items: readonly T[],
  batchSize: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const truncatedBatchSize = Math.trunc(batchSize);
  const normalizedBatchSize = Number.isFinite(truncatedBatchSize) && truncatedBatchSize > 0
    ? truncatedBatchSize
    : 1;
  const results: R[] = [];

  for (let start = 0; start < items.length; start += normalizedBatchSize) {
    const batch = items.slice(start, start + normalizedBatchSize);
    const batchResults = await Promise.all(batch.map((item, offset) => mapper(item, start + offset)));
    results.push(...batchResults);
    if (start + normalizedBatchSize < items.length) {
      await Promise.all([
        new Promise<void>((resolve) => setImmediate(resolve)),
        new Promise<void>((resolve) => setTimeout(resolve, 0)),
      ]);
    }
  }

  return results;
}
