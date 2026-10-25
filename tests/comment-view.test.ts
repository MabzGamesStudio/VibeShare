import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { commentThreads, formatCommentDate } from '../src/shared/comment-view.js';
import type { CommentEntry } from '../src/shared/comments.js';

function comment(id: string, replyFrom: string): CommentEntry {
  return {
    id,
    text: id,
    time: '2026-01-02T03:04:05.000Z',
    replyFrom,
    anonymous: false,
    edited: false,
    likes: 0,
    dislikes: 0,
    mine: 0,
    history: [],
  };
}

describe('the comment thread presentation', () => {
  it('places replies below their actual parent, including nested and forward links', () => {
    const roots = commentThreads(
      [comment('reply', 'parent'), comment('other', 'root'), comment('nested', 'reply'), comment('parent', 'root'), comment('orphan', 'removed-parent')],
      'root'
    );
    assert.deepEqual(roots.map((node) => node.entry.id), ['other', 'parent', 'orphan']);
    const parent = roots.find((node) => node.entry.id === 'parent')!;
    assert.deepEqual(parent.replies.map((node) => node.entry.id), ['reply']);
    assert.deepEqual(parent.replies[0].replies.map((node) => node.entry.id), ['nested']);
    assert.deepEqual(parent.replies[0].replies[0].replies, []);
  });

  it('formats dates independently of the timestamp precision stored on a post', () => {
    const now = Date.parse('2026-01-02T05:04:05.000Z');
    assert.match(formatCommentDate('2026-01-02T03:04:05.000Z', 'relative', now), /2 hours ago/);
    assert.equal(formatCommentDate('2026-01-02T03:04:05.000Z', 'iso', now), '2026-01-02T03:04:05.000Z');
    assert.equal(formatCommentDate('2026', 'local', now), '2026');
    assert.equal(formatCommentDate('2026-01-02T03:04:05.000Z', 'hidden', now), '');
  });
});
