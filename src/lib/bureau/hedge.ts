import type { ShotGraphics } from './graphics';

/**
 * Numbers must be sourced or hedged (the engineered format, 0052). Pure; policy_lint applies
 * it to every engineered brief — the script and every graphic a viewer reads.
 */

/** Units that make even a small number a measured claim ("5 tonnes", "3 s", "40%"). */
const MEASURE = /^(%|°[CF]?|km\/h|mph|kph|m\/s|kg|g|lbs?|tonnes?|tons?|mm|cm|m|km|ft|feet|foot|inch(es)?|s|secs?|seconds?|ms|min(ute)?s?|h|hrs?|hours?|degrees?|n|kn|j|kj|w|kw|v|volts?|amps?|bar|psi|pa|kpa|l|litres?|liters?|ml|hz|times|x|g's?)\.?$/i;

const HEDGE = /(≈|~|\babout|\baround|\broughly|\bnearly|\balmost|\bapproximately|\bapprox\.?|\bup to|\bover|\bunder|\bmore than|\bless than|\bat least|\bat most|\bsome|\bclose to|\bjust over|\bjust under|\bon the order of)\s*$/i;

/**
 * Every numeric claim in `text` that is neither hedged nor the sourced fact's own figure.
 *
 * Checked: numerals (digits). A number with a unit or above ten is a measurement claim and
 * needs "≈"/"about"/… within the few words before it, unless the same figure is in a sourced
 * text (the fact's claim). Not checked: small bare counts ("2 tries", "attempt 3"), bare
 * four-digit years, ordinals. Spelled-out numbers are not parsed — the writer is told to use
 * numerals for every measured figure, and the hedge is what a viewer reads beside it.
 */
export function unhedgedNumbers(text: string, sourced: readonly string[] = []): string[] {
  const out: string[] = [];
  const sourcedNums = new Set(sourced.flatMap((s) => [...s.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,/g, ''))));
  const re = /(\d[\d,]*(?:\.\d+)?)(\s?(?:st|nd|rd|th)\b)?(\s?(?:%|[A-Za-z°µ]+\.?(?:\/[A-Za-z]+)?))?/g;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > 0 && /[A-Za-z_]/.test(text[at - 1])) continue; // part of a word ("gen4", "S01")
    const num = m[1].replace(/,/g, '');
    if (m[2]) continue; // ordinal
    const value = Number(num);
    const unit = (m[3] ?? '').trim();
    // A small whole number is a count ("2 tries", "attempt 3") unless a measurement unit follows.
    if (Number.isInteger(value) && value <= 10 && !MEASURE.test(unit)) continue;
    if (!unit && /^\d{4}$/.test(num) && value >= 1500 && value <= 2100) continue;
    if (sourcedNums.has(num)) continue;
    const before = text.slice(Math.max(0, at - 24), at);
    if (HEDGE.test(before)) continue;
    out.push(`${m[1]}${m[3] ?? ''}`.trim().replace(/\.$/, ''));
  }
  return [...new Set(out)];
}

/** Is this brief written in the engineered format? (any shot carries engineered fields) */
export function isEngineeredShotList(shots: readonly Record<string, unknown>[] | undefined): boolean {
  return (shots ?? []).some((s) => s.graphics !== undefined || s.view !== undefined);
}

/** The text of every graphic a viewer reads, for the hedge check. */
export function graphicsText(g: ShotGraphics | undefined | null): string {
  if (!g) return '';
  return [g.badge?.label, g.verdict?.text, g.verdict?.sub, ...(g.callouts ?? []).map((c) => c.label), ...(g.meters ?? []).flatMap((m) => [m.label, m.unit])].filter(Boolean).join('\n');
}

