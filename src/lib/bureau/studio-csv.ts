import type { Db } from '../db/server';

/**
 * YouTube Studio CSV import, for the one Shorts metric the Analytics API does not return:
 * "Viewed vs. swiped away". Export from Studio → Analytics → Advanced → (Shorts) → per video,
 * and paste or upload the CSV on the Metrics page.
 *
 * Columns are matched by header text, case-insensitively, because Studio has renamed them:
 * the video id column ("Content" / "Video"), the percentage ("Viewed vs. swiped away" /
 * "Stayed to watch (%)"), and optionally "Views". A row whose video is not one of ours, or
 * whose percentage is not a number in 0–100, is reported — never written as 0.
 */

export interface CsvRow {
  videoId: string;
  viewedPct: number | null;
  views: number | null;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function parseStudioCsv(text: string): { rows: CsvRow[]; problems: string[] } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { rows: [], problems: ['the file is empty'] };
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const idCol = header.findIndex((h) => /^(content|video|video id)$/.test(h));
  const pctCol = header.findIndex((h) => /viewed vs\.? swiped|stayed to watch/.test(h));
  const viewsCol = header.findIndex((h) => h === 'views');
  const problems: string[] = [];
  if (idCol < 0) problems.push('no "Content" / "Video" column');
  if (pctCol < 0) problems.push('no "Viewed vs. swiped away" / "Stayed to watch (%)" column');
  if (problems.length) return { rows: [], problems };
  const rows: CsvRow[] = [];
  for (const [n, line] of lines.slice(1).entries()) {
    const cells = splitCsvLine(line);
    const id = cells[idCol];
    if (!id || /^total$/i.test(id)) continue;
    const pctRaw = cells[pctCol]?.replace('%', '');
    const pct = pctRaw === undefined || pctRaw === '' ? null : Number(pctRaw);
    if (pct !== null && !(Number.isFinite(pct) && pct >= 0 && pct <= 100)) {
      problems.push(`row ${n + 2}: "${cells[pctCol]}" is not a percentage`);
      continue;
    }
    const v = viewsCol >= 0 && cells[viewsCol] ? Number(cells[viewsCol].replace(/,/g, '')) : null;
    rows.push({ videoId: id, viewedPct: pct, views: v !== null && Number.isFinite(v) ? v : null });
  }
  return { rows, problems };
}

export async function importStudioCsv(db: Db, channelId: string, text: string) {
  const { rows, problems } = parseStudioCsv(text);
  let updated = 0;
  let inserted = 0;
  const unmatched: string[] = [];
  for (const r of rows) {
    if (r.viewedPct === null) continue;
    const { data: pub } = await db.from('publications').select('id').eq('channel_id', channelId).eq('external_post_id', r.videoId).maybeSingle();
    if (!pub) {
      unmatched.push(r.videoId);
      continue;
    }
    const { data: latest } = await db
      .from('metrics_snapshots')
      .select('id')
      .eq('publication_id', pub.id)
      .eq('status', 'measured')
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latest) {
      await db.from('metrics_snapshots').update({ viewed_vs_swiped_pct: r.viewedPct, updated_at: new Date().toISOString() }).eq('id', latest.id);
      updated++;
    } else if (r.views !== null) {
      await db.from('metrics_snapshots').insert({ publication_id: pub.id, age_bucket: '7d', views: r.views, viewed_vs_swiped_pct: r.viewedPct, metric_source: 'studio_csv', status: 'measured' });
      inserted++;
    } else {
      problems.push(`${r.videoId}: no snapshot yet and the CSV has no Views column to start one`);
    }
  }
  return { rows: rows.length, updated, inserted, unmatched, problems };
}
