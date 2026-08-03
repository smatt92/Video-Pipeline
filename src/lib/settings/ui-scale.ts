/**
 * The UI scale preference.
 *
 * No `server-only` here on purpose: the steps and the clamp are needed by the Settings
 * form, the command palette and the pre-paint script, and two of those are client code.
 * Nothing in this file touches a credential or the database.
 */

/**
 * The steps, and why it is a closed set.
 *
 * A slider producing 1.37 gives fractional pixel values, and the places that show is
 * exactly the places nobody tests: 1px borders that render at 1.37px and get rounded
 * inconsistently between adjacent elements, so a panel gains a visibly heavier edge on one
 * side. VS Code, Figma and Zed all ship a stepper for the same reason.
 *
 * 150% is the top because the layout is a fixed-sidebar two-column shell; past that the
 * canvas stops being usable at 1440px logical width and the honest answer is browser zoom,
 * which also scales the viewport the layout is reasoning about.
 */
export const UI_SCALES = [0.9, 1.0, 1.1, 1.25, 1.5] as const;
export type UiScale = (typeof UI_SCALES)[number];

export const DEFAULT_UI_SCALE: UiScale = 1.0;

export function isUiScale(value: unknown): value is UiScale {
  return typeof value === 'number' && (UI_SCALES as readonly number[]).includes(value);
}

/** Nearest valid step. Used when a stored value predates a change to the set. */
export function coerceUiScale(value: unknown): UiScale {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_UI_SCALE;
  if (isUiScale(n)) return n;
  return UI_SCALES.reduce((best, step) =>
    Math.abs(step - n) < Math.abs(best - n) ? step : best,
  );
}

export function labelFor(scale: UiScale): string {
  return `${Math.round(scale * 100)}%`;
}

/** Where the value is mirrored for the pre-auth splash, which has no profile to read. */
export const UI_SCALE_STORAGE_KEY = 'kiln.ui-scale';

/**
 * The script that puts the scale on the document before anything paints.
 *
 * Inlined into `<head>` and deliberately synchronous. The alternative — read it in an
 * effect — renders every page once at 100% and then jumps, and on the display this feature
 * exists for that jump is from unreadable to readable, on every navigation.
 *
 * The server-rendered value wins when there is one; localStorage is the fallback for the
 * pre-auth screens. Written as a string rather than a component because it has to run
 * before hydration, and anything React renders is by definition after it.
 */
export function uiScaleBootstrapScript(serverValue: number | null): string {
  const initial = serverValue === null ? 'null' : String(coerceUiScale(serverValue));
  return `(function(){try{
var s=${initial};
if(s===null){var v=parseFloat(localStorage.getItem(${JSON.stringify(UI_SCALE_STORAGE_KEY)})||'');if(v>0)s=v;}
if(s&&s!==1)document.documentElement.style.setProperty('--ui-scale',String(s));
}catch(e){}})();`;
}
