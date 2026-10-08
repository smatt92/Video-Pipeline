/**
 * The Content-Type an object is stored with, from its key's extension.
 *
 * Every upload went up as `video/mp4` until 08-Oct — the putter was written for clips and
 * stills, sheets and voice lines later borrowed it. The bucket serves the stored type back,
 * and a model that is handed a reference image checks it: Runway refused every picture of
 * the first 3D explainer ("Unsupported Content-Type response header: video/mp4" on each
 * referenceImages uri) and the cut fell back to chalk diagrams. Nothing else noticed —
 * Remotion and ffmpeg sniff the bytes and never read the header.
 *
 * An unknown extension is `application/octet-stream`: honest, and refused loudly by anything
 * that needs a specific type, instead of a confident wrong label.
 */
const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  json: 'application/json',
  srt: 'application/x-subrip',
  vtt: 'text/vtt',
  txt: 'text/plain',
};

export function contentTypeFor(key: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(key)?.[1]?.toLowerCase();
  return (ext && TYPES[ext]) ?? 'application/octet-stream';
}
