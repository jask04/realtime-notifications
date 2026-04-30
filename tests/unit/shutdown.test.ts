import { describe, expect, test, vi } from 'vitest';
import { closeAllInOrder } from '../../src/lib/shutdown.js';

describe('closeAllInOrder', () => {
  test('closes targets sequentially in declared order', async () => {
    const order: string[] = [];
    const make = (name: string, delayMs: number) => ({
      name,
      close: async () => {
        await new Promise((r) => setTimeout(r, delayMs));
        order.push(name);
      },
    });
    // First target takes longer than the second; order must still be a, b, c.
    await closeAllInOrder([
      make('a', 30),
      make('b', 5),
      make('c', 5),
    ]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  test('a throwing close does not skip later targets', async () => {
    const closed: string[] = [];
    const failed = await closeAllInOrder([
      { name: 'http', close: async () => void closed.push('http') },
      {
        name: 'workers',
        close: async () => {
          throw new Error('worker close blew up');
        },
      },
      { name: 'redis', close: async () => void closed.push('redis') },
    ]);
    expect(closed).toEqual(['http', 'redis']);
    expect(failed).toEqual(['workers']);
  });

  test('reports every failed target', async () => {
    const failed = await closeAllInOrder([
      {
        name: 'a',
        close: async () => {
          throw new Error('a');
        },
      },
      {
        name: 'b',
        close: async () => {
          throw new Error('b');
        },
      },
    ]);
    expect(failed).toEqual(['a', 'b']);
  });

  test('handles an empty target list without error', async () => {
    const failed = await closeAllInOrder([]);
    expect(failed).toEqual([]);
  });

  test('awaits async closes — returns only after the last one resolves', async () => {
    const tick = vi.fn();
    await closeAllInOrder([
      {
        name: 'slow',
        close: async () => {
          await new Promise((r) => setTimeout(r, 20));
          tick();
        },
      },
    ]);
    expect(tick).toHaveBeenCalledTimes(1);
  });
});
