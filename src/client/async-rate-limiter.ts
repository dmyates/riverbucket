type TimerHandle = ReturnType<typeof setTimeout>;

type RateLimiterClock = {
  now: () => number;
  setTimeout: (callback: () => void, delay: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
};

export type AsyncRateLimiter = {
  trigger: () => void;
  dispose: () => void;
};

const defaultClock: RateLimiterClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle)
};

export function createAsyncRateLimiter(
  callback: () => Promise<unknown>,
  intervalMs: number,
  clock: RateLimiterClock = defaultClock
): AsyncRateLimiter {
  let disposed = false;
  let running = false;
  let pending = false;
  let timer: TimerHandle | null = null;
  let lastStartedAt = Number.NEGATIVE_INFINITY;

  function schedule() {
    if (disposed || running || timer !== null || !pending) return;
    const delay = Math.max(0, lastStartedAt + intervalMs - clock.now());
    if (delay === 0) {
      void run();
      return;
    }
    timer = clock.setTimeout(() => {
      timer = null;
      void run();
    }, delay);
  }

  async function run() {
    if (disposed || running || !pending) return;
    pending = false;
    running = true;
    lastStartedAt = clock.now();
    try {
      await callback();
    } finally {
      running = false;
      schedule();
    }
  }

  return {
    trigger() {
      if (disposed) return;
      pending = true;
      schedule();
    },
    dispose() {
      disposed = true;
      pending = false;
      if (timer !== null) {
        clock.clearTimeout(timer);
        timer = null;
      }
    }
  };
}
