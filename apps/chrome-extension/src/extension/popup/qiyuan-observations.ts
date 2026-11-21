export interface Observation { platform: string; title: string; author: string; time: string; url: string }

// Only the user's current request counts, never an earlier conversation.
export function collectionPlatforms(prompt: string): string[] {
  const intent = prompt.split('【对话上下文')[0];
  if (!/(搜索|查找|搜集|收集|整理|汇总|浏览|热门|近期|最新|帖子|笔记|文章)/.test(intent)) return [];
  return ['小红书', '抖音', '知乎'].filter(p => intent.includes(p));
}

export function normalizeObservations(items: unknown, platforms: string[]): Observation[] {
  if (!Array.isArray(items) || !platforms.length) return [];
  const out: Observation[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const v = item as Record<string, unknown>;
    const text = (key: string, max: number) => typeof v[key] === 'string' ? (v[key] as string).replace(/\s+/g, ' ').trim().slice(0, max) : '';
    const platform = text('platform', 20), title = text('title', 200);
    if (!platforms.includes(platform) || title.length < 6) continue;
    let url = text('url', 500);
    try { if (url && !/^https?:$/.test(new URL(url).protocol)) url = ''; } catch { url = ''; }
    out.push({ platform, title, author: text('author', 100), time: text('time', 100), url });
  }
  return out;
}

export function observationBatches(items: Observation[], maxBytes = 6500): Observation[][] {
  const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
  const batches: Observation[][] = [];
  let batch: Observation[] = [];
  for (const item of items) {
    if (bytes([item]) > maxBytes) continue;
    if (bytes([...batch, item]) > maxBytes) { batches.push(batch); batch = []; }
    batch.push(item);
  }
  if (batch.length) batches.push(batch);
  return batches;
}
