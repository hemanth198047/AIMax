import React, { useEffect, useRef, useState } from 'react';
import { Check, Copy, X } from 'lucide-react';
import clsx from 'clsx';
import { copyText } from '../lib/clipboard';

/** Copy button with the usual feedback: the icon turns into a check for ~2 s ("Copied"), or a cross if the browser refused. */
export default function CopyButton({ getText, label = 'Copy', variant = 'icon', testId, className }:
  { getText: () => string; label?: string; variant?: 'icon' | 'text'; testId?: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const onClick = async () => {
    const ok = await copyText(getText());
    setState(ok ? 'copied' : 'failed');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2000);
  };
  const Icon = state === 'copied' ? Check : state === 'failed' ? X : Copy;
  const text = state === 'copied' ? 'Copied' : state === 'failed' ? 'Failed' : label;
  return (
    <button type="button" onClick={onClick} data-testid={testId} data-state={state} aria-label={label} title={text}
      className={clsx('inline-flex items-center gap-1 rounded transition-colors', state === 'copied' ? 'text-emerald-400' : state === 'failed' ? 'text-red-400' : 'text-slate-500 hover:text-slate-200', className)}>
      <Icon size={variant === 'icon' ? 14 : 12} />
      {variant === 'text' && <span className="text-[11px]">{text}</span>}
      <span className="sr-only" role="status">{state === 'copied' ? 'Copied to clipboard' : ''}</span>
    </button>
  );
}
