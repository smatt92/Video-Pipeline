/**
 * The id the 0037 migration gave the first channel, the Bureau of Reality.
 *
 * A fixture, not configuration: harnesses and the migration seed use it to name that row.
 * Nothing in the running app may read it to decide which channel it is acting for — that comes
 * from the episode/brief/slot row, the MCP token, or the active-channel cookie
 * (`src/lib/channels/active.ts`). `grep -rn BUREAU_CHANNEL_ID src/` should find this line only.
 */
export const BUREAU_CHANNEL_ID = 'b0000000-0000-4000-8000-000000000001';
