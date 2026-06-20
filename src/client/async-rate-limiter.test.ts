import { afterEach, describe, expect, it, vi } from "vitest";
import { createAsyncRateLimiter } from "./async-rate-limiter";

afterEach(() => {
  vi.useRealTimers();
});

describe("createAsyncRateLimiter", () => {
  it("runs immediately and coalesces bursts into one trailing run", async () => {
    vi.useFakeTimers();
    const callback = vi.fn(async () => undefined);
    const limiter = createAsyncRateLimiter(callback, 10_000);

    limiter.trigger();
    limiter.trigger();
    limiter.trigger();
    await vi.advanceTimersByTimeAsync(0);
    expect(callback).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(callback).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("does not overlap calls and runs pending work after the interval", async () => {
    vi.useFakeTimers();
    let resolveFirst: (() => void) | undefined;
    const callback = vi.fn(() => new Promise<void>((resolve) => {
      resolveFirst = resolve;
    }));
    const limiter = createAsyncRateLimiter(callback, 10_000);

    limiter.trigger();
    await vi.advanceTimersByTimeAsync(0);
    limiter.trigger();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(callback).toHaveBeenCalledTimes(1);

    resolveFirst?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("cancels trailing work when disposed", async () => {
    vi.useFakeTimers();
    const callback = vi.fn(async () => undefined);
    const limiter = createAsyncRateLimiter(callback, 10_000);

    limiter.trigger();
    await vi.advanceTimersByTimeAsync(0);
    limiter.trigger();
    limiter.dispose();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(callback).toHaveBeenCalledTimes(1);
  });
});
