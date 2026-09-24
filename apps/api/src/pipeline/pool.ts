/**
 * Runs async tasks with a cap on how many are in flight at once.
 *
 * A 20-page book with two children is 40 face swaps. Firing those all at once
 * would hit provider rate limits and give the worker no way to fail fast, while
 * running them one at a time would make a book take minutes. This keeps a
 * bounded number in flight.
 *
 * Results come back in input order. The first rejection propagates (after
 * in-flight tasks settle), so a failed page fails the job rather than silently
 * producing a partial book.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const max = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  let firstError: unknown;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index] as T;
      try {
        results[index] = await task(item, index);
      } catch (error) {
        // Keep the first failure and stop handing out new work; in-flight tasks
        // are still allowed to settle so nothing is left dangling.
        firstError ??= error;
        next = items.length;
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: max }, () => worker()));
  if (firstError) throw firstError;
  return results;
}
