import 'server-only';

import { tasks, wait } from '@trigger.dev/sdk';

import { readUsdInrRate } from '../cost/fx';
import { requireCredential } from '../integrations/credentials';
import { judgeLint } from './brief-generator';
import type { Db } from '../db/server';
import { ledgeredEmbedder } from './embed';
import type { SheetEffects } from './character-sheets';
import type { BureauSideEffects } from './mcp/surface';
import { notify, type NotificationKind } from './alerts';

/**
 * The production side effects behind the control plane: start an episode run, wake a cut
 * gate, send an alert, embed a brief. Kept out of the tool modules so a harness can drive
 * every tool with recording fakes and the real implementations live in one file.
 *
 * Needs TRIGGER_SECRET_KEY on Vercel (the same key `publish/actions.ts` already uses).
 */
export function productionEffects(db: Db): BureauSideEffects {
  return {
    async startEpisode(episodeId, attempt) {
      // The first start keys on the episode alone; a restart adds the attempt marker the caller
      // derives from the halted row, so a double click dedupes but a later halt can restart.
      const idempotencyKey = attempt ? `episode:${episodeId}:${attempt}` : `episode:${episodeId}`;
      const handle = await tasks.trigger('20-episode', { episodeId }, { idempotencyKey });
      return handle.id;
    },
    async startRedraw(input) {
      // One run per redraw request: the request id is the key, so a double submit starts one run.
      const handle = await tasks.trigger('25-redraw', input, { idempotencyKey: `redraw:${input.redrawId}` });
      return handle.id;
    },
    async startInstagramPost(publicationId, attempt) {
      const handle = await tasks.trigger('26-ig-post', { publicationId }, { idempotencyKey: `igpost:${publicationId}:${attempt}` });
      return handle.id;
    },
    async completeWaitToken(tokenId, output) {
      await wait.completeToken(tokenId, output);
    },
    async notify(channelId, kind, text, dedupeKey) {
      await notify(db, channelId, kind as NotificationKind, text, { dedupeKey });
    },
    async judgeFor(d, ch) {
      const fx = await readUsdInrRate(d);
      const apiKey = await requireCredential(d, 'anthropic', 'ANTHROPIC_API_KEY').catch(() => null);
      if (!fx.ok || !apiKey) return undefined;
      return (lint, text) =>
        judgeLint(lint, text, {
          db: d,
          apiKey,
          usdInrRate: fx.rate,
          subject: { kind: 'channel', channelId: ch, idempotencyKey: `judge:${crypto.randomUUID()}`, stage: '20-policy-judge' },
        });
    },
    async embedderFor(d, ch) {
      const fx = await readUsdInrRate(d);
      return ledgeredEmbedder(d, ch, fx.ok ? fx.rate : null);
    },
  };
}

/** Library → Characters → "Generate sheet": starts 27-character-sheet, one run per request. */
export function productionSheetEffects(): Required<SheetEffects> {
  return {
    async startSheet(input) {
      const handle = await tasks.trigger('27-character-sheet', input, { idempotencyKey: `sheet:${input.requestId}` });
      return handle.id;
    },
  };
}
