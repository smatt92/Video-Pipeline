import Link from 'next/link';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import { Icon, type IconName } from './icon';

/**
 * Button (canvas: Components → Buttons). `pri` is the one primary action on a surface, `ghost`
 * the quiet one, `dan` the destructive one. 34px desktop; on mobile kiln.css lifts every
 * button to 44px, so a size prop never has to know which device it is on.
 *
 * There is deliberately no variant for "Publish now" or "Skip review": the only path to Ready
 * is Approve cut, and a button component that offered either would be an invitation.
 */
export type ButtonVariant = 'default' | 'pri' | 'ghost' | 'dan';
export type ButtonSize = 'md' | 'sm' | 'lg';

interface Common {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  /** Icon-only button. `label` becomes the accessible name. */
  iconOnly?: boolean;
  full?: boolean;
  label?: string;
  children?: ReactNode;
}

export function btnClass({ variant = 'default', size = 'md', iconOnly, full }: Pick<Common, 'variant' | 'size' | 'iconOnly' | 'full'>, extra = '') {
  return ['btn', variant !== 'default' && variant, size !== 'md' && size, iconOnly && 'icon', full && 'full', extra]
    .filter(Boolean)
    .join(' ');
}

export function Button({
  variant,
  size,
  icon,
  iconOnly,
  full,
  label,
  children,
  className,
  type = 'button',
  ...rest
}: Common & Omit<ComponentPropsWithoutRef<'button'>, 'children'>) {
  return (
    <button
      type={type}
      className={btnClass({ variant, size, iconOnly, full }, className)}
      aria-label={iconOnly ? label : rest['aria-label']}
      {...rest}
    >
      {icon && <Icon name={icon} />}
      {iconOnly ? null : children}
    </button>
  );
}

export function ButtonLink({
  href,
  variant,
  size,
  icon,
  iconOnly,
  full,
  label,
  children,
  className,
  external,
}: Common & { href: string; className?: string; external?: boolean }) {
  const cls = btnClass({ variant, size, iconOnly, full }, className);
  const inner = (
    <>
      {icon && <Icon name={icon} />}
      {iconOnly ? null : children}
    </>
  );
  if (external) {
    return (
      <a href={href} className={cls} aria-label={iconOnly ? label : undefined} target="_blank" rel="noreferrer">
        {inner}
      </a>
    );
  }
  return (
    <Link href={href} className={cls} aria-label={iconOnly ? label : undefined}>
      {inner}
    </Link>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
