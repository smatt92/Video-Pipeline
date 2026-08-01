# Pipeline stages

One file per stage, numbered by the table in `docs/ARCHITECTURE.md` §4. The numbering is
the point: it makes the DAG readable from `ls`, and it makes "replay from stage N"
a concrete instruction rather than a conversation.

```
01-trends.ts      04-prompt-compile.ts   07-assemble.ts   10-publish.ts
02-concepts.ts    05-generate.ts         08-qa.ts         11-measure.ts
03-script.ts      06-voice.ts            09-metadata.ts
```

Phase 1 builds `05-generate.ts` first, then `03-script.ts` and `04-prompt-compile.ts`
behind it — the generate leg is proved against the real API before anything automates
what feeds it.

Every task in here: has a concurrency limit, is replayable from any prior stage's output,
writes its failure states as rows, and writes a cost row wherever money moved.

Nothing else runs here. ffmpeg, Remotion, and any call that takes longer than a Vercel
function is allowed to live — that is the whole reason this directory is not `src/app/`.
