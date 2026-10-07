/** "Bureau of Reality" → "BR". Shared by the rail (server data) and headers. */
export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter((w) => w && !/^(of|the|and|a)$/i.test(w));
  return (words.length >= 2 ? words[0]![0]! + words[1]![0]! : (words[0] ?? '?').slice(0, 2)).toUpperCase();
}
