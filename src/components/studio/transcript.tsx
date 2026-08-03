import type { TranscriptEntry } from '@/lib/studio/session';

/**
 * The transcript, rendered.
 *
 * 0003's comment on the column: *"Full turn history. This is originality evidence under the
 * inauthentic-content policy, not a debug log — do not truncate it, and do not drop turns
 * on archive."* So this renders every turn, including the tool traffic, and it never
 * collapses anything behind "show more" that would not survive a screenshot.
 *
 * Tool calls are shown as their own rows rather than folded into the assistant's text. What
 * the model *said* it did and what the tools *actually returned* are different claims, and
 * a surface that shows only the first is exactly the surface that lets an invented result
 * pass unnoticed.
 */

interface Block {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
  thinking?: string;
}

function blocksOf(content: unknown): Block[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content.filter((b): b is Block => !!b && typeof b === 'object');
  return [];
}

function refusalOf(content: unknown): { summary?: string; blockers?: { code: string; detail: string; remedy: string }[] } | null {
  const parse = (text: string) => {
    try {
      const v = JSON.parse(text);
      return v && typeof v === 'object' && (v as { refused?: unknown }).refused === true ? v : null;
    } catch {
      return null;
    }
  };

  if (typeof content === 'string') return parse(content);
  if (!Array.isArray(content)) return null;

  for (const b of content) {
    if (b && typeof b === 'object' && (b as Block).type === 'text') {
      const hit = parse(String((b as Block).text ?? ''));
      if (hit) return hit;
    }
  }
  return null;
}

export function Transcript({ entries }: { entries: TranscriptEntry[] }) {
  if (entries.length === 0) {
    return (
      <p className="px-4 py-6 text-sm" style={{ color: 'var(--text-muted)' }}>
        Nothing yet. Describe what you are trying to make. The tools will refuse anything
        the workspace is not actually set up to do, and say what would change that.
      </p>
    );
  }

  return (
    <div className="flex flex-col">
      {entries.map((entry, i) => (
        <TurnRow key={`${entry.at}-${i}`} entry={entry} />
      ))}
    </div>
  );
}

function TurnRow({ entry }: { entry: TranscriptEntry }) {
  const blocks = blocksOf(entry.content);
  const isToolResults = entry.role === 'user' && entry.toolResults === true;

  return (
    <div
      className="border-b px-4 py-3 last:border-b-0"
      style={{ borderColor: 'var(--border-subtle)' }}
    >
      <div className="mb-1 flex items-baseline gap-2">
        <span
          className="font-mono text-3xs uppercase tracking-[0.09em]"
          style={{ color: 'var(--text-faint)' }}
        >
          {isToolResults ? 'tool results' : entry.role}
        </span>
        <span className="font-mono text-3xs" style={{ color: 'var(--text-faint)' }}>
          {entry.at.slice(11, 19)}
        </span>
        {entry.stopReason && entry.stopReason !== 'end_turn' && (
          <span className="font-mono text-3xs" style={{ color: 'var(--state-blocked)' }}>
            {entry.stopReason}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {blocks.map((block, i) => (
          <BlockRow key={i} block={block} />
        ))}
      </div>
    </div>
  );
}

function BlockRow({ block }: { block: Block }) {
  switch (block.type) {
    case 'text':
      return (
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{block.text}</p>
      );

    case 'thinking':
    case 'redacted_thinking':
      // Present but visually quiet. It is part of the record and it is not the argument.
      return (
        <details className="text-xs" style={{ color: 'var(--text-faint)' }}>
          <summary className="cursor-pointer font-mono text-3xs uppercase tracking-[0.09em]">
            reasoning
          </summary>
          <p className="mt-1 whitespace-pre-wrap leading-relaxed">
            {block.thinking ?? '(redacted)'}
          </p>
        </details>
      );

    case 'tool_use':
    case 'mcp_tool_use':
      return (
        <div
          className="rounded-sm border px-2 py-[6px]"
          style={{ background: 'var(--surface-inset)', borderColor: 'var(--border-subtle)' }}
        >
          <div className="font-mono text-2xs">→ {block.name}</div>
          <pre
            className="mt-1 overflow-x-auto font-mono text-2xs leading-snug"
            style={{ color: 'var(--text-faint)' }}
          >
            {JSON.stringify(block.input ?? {}, null, 2)}
          </pre>
        </div>
      );

    case 'tool_result':
    case 'mcp_tool_result': {
      const refusal = refusalOf(block.content);

      // A refusal renders as a refusal, not as an error and not as a wall of JSON. This is
      // the shape the session is expected to produce on a fresh install, and the screen
      // should make that read as the system working.
      if (refusal) {
        return (
          <div
            className="rounded-sm border px-2 py-[6px]"
            style={{ background: 'var(--surface-inset)', borderColor: 'var(--border-subtle)' }}
          >
            <div className="font-mono text-2xs" style={{ color: 'var(--state-blocked)' }}>
              ← refused
            </div>
            {refusal.summary && (
              <p className="mt-1 text-xs leading-relaxed">{refusal.summary}</p>
            )}
            {refusal.blockers?.map((b) => (
              <div key={b.code} className="mt-2">
                <div className="font-mono text-3xs" style={{ color: 'var(--text-faint)' }}>
                  {b.code}
                </div>
                <p className="text-xs leading-snug">{b.detail}</p>
                <p className="text-xs leading-snug" style={{ color: 'var(--text-muted)' }}>
                  {b.remedy}
                </p>
              </div>
            ))}
          </div>
        );
      }

      return (
        <div
          className="rounded-sm border px-2 py-[6px]"
          style={{ background: 'var(--surface-inset)', borderColor: 'var(--border-subtle)' }}
        >
          <div
            className="font-mono text-2xs"
            style={{ color: block.is_error ? 'var(--state-blocked)' : 'var(--text-secondary)' }}
          >
            ← {block.is_error ? 'error' : 'result'}
          </div>
          <pre
            className="mt-1 max-h-[240px] overflow-auto font-mono text-2xs leading-snug"
            style={{ color: 'var(--text-faint)' }}
          >
            {typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content ?? null, null, 2)}
          </pre>
        </div>
      );
    }

    default:
      return (
        <pre
          className="overflow-x-auto font-mono text-2xs"
          style={{ color: 'var(--text-faint)' }}
        >
          {JSON.stringify(block, null, 2)}
        </pre>
      );
  }
}
