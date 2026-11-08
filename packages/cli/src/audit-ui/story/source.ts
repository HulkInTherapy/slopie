/**
 * The only place that reads the engine's story fields off a snapshot. Everything is optional:
 * an older snapshot (1.7.x) simply has no story and the deck falls back to wallboard facts.
 */
import type { AuditSnapshot } from '../../../../core/src/analytics/contracts.js';
import type { AuditProgressDetail, AuditStory, StoryCard } from './types.js';

export function storyOf(snapshot: AuditSnapshot): AuditStory | null {
  const story = (snapshot.launch as { story?: AuditStory | null } | undefined)?.story;
  if (!story || typeof story !== 'object' || !Array.isArray(story.cards)) return null;
  return story;
}

export function progressDetailOf(snapshot: AuditSnapshot): AuditProgressDetail | null {
  const detail = (snapshot.progress as { detail?: AuditProgressDetail | null }).detail;
  return detail && typeof detail === 'object' && Array.isArray(detail.harnesses) ? detail : null;
}

/** Fired detector card by id. */
export function cardOf(story: AuditStory | null, id: string): StoryCard | null {
  return story?.cards.find(card => card.id === id) ?? null;
}

export function num(card: StoryCard | null, key: string): number | null {
  const value = card?.numbers[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function str(card: StoryCard | null, key: string): string | null {
  const value = card?.numbers[key];
  return typeof value === 'string' && value ? value : null;
}

/**
 * True when this run may have sent anything off the machine (Jev wording or online classification).
 * Only runs that never dispatched a request may say "all local"; a failed or timed-out request
 * still counts, because the text may have left before it failed.
 */
export function wentOnline(snapshot: AuditSnapshot, transfers = 0): boolean {
  if (transfers > 0) return true;
  const story = storyOf(snapshot);
  const e = story?.enrichment;
  if (e && (e.quotesSent > 0 || e.state === 'pending' || e.state === 'complete' || (e.state === 'failed' && e.model !== null))) return true;
  const sem = snapshot.launch?.semantics as { requestCount?: number } | null | undefined;
  if (sem && typeof sem.requestCount === 'number' && sem.requestCount > 0) return true;
  return (snapshot.semantics?.requestCount ?? 0) > 0;
}
