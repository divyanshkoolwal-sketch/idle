import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import clsx from 'clsx';

/** Tweens a number to its new value (ease-out cubic, ~450 ms). Respects reduced motion. */
export function useTicker(target: number, duration = 450): number {
  const reduce = useReducedMotion();
  const [val, setVal] = useState(target);
  const current = useRef(target);
  const raf = useRef(0);
  useEffect(() => {
    if (reduce || !Number.isFinite(target)) {
      current.current = target;
      setVal(target);
      return;
    }
    const a = current.current;
    const b = target;
    if (a === b) return;
    const start = performance.now();
    cancelAnimationFrame(raf.current);
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / duration);
      const e = 1 - Math.pow(1 - k, 3);
      const v = a + (b - a) * e;
      current.current = v;
      setVal(v);
      if (k < 1) raf.current = requestAnimationFrame(tick);
      else current.current = b;
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target, duration, reduce]);
  return val;
}

export function Num({ value, decimals = 0, className }: { value: number; decimals?: number; className?: string }) {
  const v = useTicker(value);
  return (
    <span className={clsx('num', className)}>
      {v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
    </span>
  );
}
