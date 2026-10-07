/**
 * Caption and hook sizes as fractions of the frame height — the defaults, in a module with no
 * imports so the composition and `src/lib/settings/tuning.ts` read the same numbers.
 * A channel's own values (channel_policy.caption_scale / hook_scale, 0049) reach the
 * composition as `BureauVideoProps.textScale`; these apply only when that prop is absent.
 */
export const DEFAULT_CAPTION_SCALE = 0.032;
export const DEFAULT_HOOK_SCALE = 0.05;
