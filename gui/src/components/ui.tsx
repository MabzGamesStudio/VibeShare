import { Check, Copy, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { copyText, gradientFor } from '../util';

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label?: ReactNode }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" />
      {label && <span>{label}</span>}
    </label>
  );
}

export function Chips<T extends string>({
  options,
  selected,
  onToggle,
  labels,
}: {
  options: readonly T[];
  selected: readonly T[];
  onToggle: (value: T) => void;
  labels?: Partial<Record<T, string>>;
}) {
  return (
    <div className="chips">
      {options.map((option) => (
        <button key={option} type="button" className={`chip ${selected.includes(option) ? 'on' : ''}`} onClick={() => onToggle(option)}>
          {labels?.[option] ?? option}
        </button>
      ))}
    </div>
  );
}

export function toggle<T>(list: readonly T[] | undefined, value: T): T[] {
  const current = list ?? [];
  return current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
}

export function CopyButton({ text, label = 'Copy', small = true }: { text: string; label?: string; small?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={small ? 'small' : ''}
      onClick={async () => {
        await copyText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />} {done ? 'Copied' : label}
    </button>
  );
}

export function CodeBox({ text, label }: { text: string; label?: string }) {
  return (
    <div className="codebox">
      <code>{text}</code>
      <CopyButton text={text} label={label} />
    </div>
  );
}

export function Avatar({ name, id, large }: { name: string; id: string; large?: boolean }) {
  const letter = (name || '?').trim().charAt(0).toUpperCase() || '?';
  return (
    <div className={`avatar ${large ? 'large' : ''}`} style={{ background: gradientFor(id || name) }}>
      {letter}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  actions,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="row between">
          <h2>{title}</h2>
          <button className="ghost icon" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        {children}
        {actions && <div className="modal-actions">{actions}</div>}
      </div>
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" />;
}

export function Loading() {
  return (
    <div className="loading">
      <Spinner />
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <h2>{title}</h2>
      {children}
    </div>
  );
}

export function StatusDot({ online, enabled = true }: { online?: boolean; enabled?: boolean }) {
  return <span className={`dot ${!enabled ? 'off' : online === false ? 'bad' : online ? 'ok' : ''}`} />;
}
