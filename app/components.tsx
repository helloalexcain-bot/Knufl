import type { ReactNode } from 'react';

/* The supplied character poses are already prepared raster artwork; rendering them directly preserves their crop and blend treatment. */
/* eslint-disable @next/next/no-img-element */

export type CharacterPose = 'hero' | 'wave' | 'wobble' | 'balance' | 'pawtap';

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? 'brand--compact' : ''}`} aria-label="Knufl">
      <span className="brand__mark" aria-hidden="true">K</span>
      <span className="brand__word">Knufl</span>
    </div>
  );
}

export function Character({
  pose,
  name,
  animated = false,
  className = '',
}: {
  pose: CharacterPose;
  name: string;
  animated?: boolean;
  className?: string;
}) {
  const assetBase = import.meta.env.BASE_URL;
  const alt: Record<CharacterPose, string> = {
    hero: `${name}, a cream bear-like Knufl, offers a friendly paw`,
    wave: `${name} waves hello`,
    wobble: `${name} makes an earnest, wobbly balance attempt`,
    balance: `${name} holds a determined Little Mountain stance`,
    pawtap: `${name} offers an oversized paw tap`,
  };
  return (
    <img
      className={`character character--${pose} ${animated ? 'character--animated' : ''} ${className}`}
      src={`${assetBase}bram/${pose}.png`}
      alt={alt[pose]}
    />
  );
}

export function Modal({
  title,
  eyebrow,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  eyebrow?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className={`modal ${wide ? 'modal--wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal__header">
          <div>
            {eyebrow && <p className="eyebrow">{eyebrow}</p>}
            <h2 id="modal-title">{title}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">×</button>
        </div>
        {children}
      </section>
    </div>
  );
}

export function Button({
  children,
  variant = 'primary',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
}) {
  return (
    <button className={`button button--${variant} ${className}`} {...props}>
      {children}
    </button>
  );
}

export function FieldLabel({ children, optional = false }: { children: ReactNode; optional?: boolean }) {
  return <span className="field-label">{children}{optional && <small>Optional</small>}</span>;
}

export function BottomNav({
  active,
  onChange,
}: {
  active: string;
  onChange: (view: 'home' | 'journey' | 'plan' | 'you') => void;
}) {
  const items = [
    ['home', '⌂', 'Together'],
    ['journey', '◌', 'Journey'],
    ['plan', '◇', 'Plan'],
    ['you', '○', 'You'],
  ] as const;
  return (
    <nav className="bottom-nav" aria-label="Main navigation">
      {items.map(([id, symbol, label]) => (
        <button
          key={id}
          className={active === id ? 'is-active' : ''}
          onClick={() => onChange(id)}
          aria-current={active === id ? 'page' : undefined}
        >
          <span aria-hidden="true">{symbol}</span>
          {label}
        </button>
      ))}
    </nav>
  );
}

export const displayDate = (date: string, long = false): string => {
  const parsed = new Date(`${date}T12:00:00`);
  return new Intl.DateTimeFormat('en-GB', long
    ? { weekday: 'long', day: 'numeric', month: 'long' }
    : { day: 'numeric', month: 'short' }).format(parsed);
};
