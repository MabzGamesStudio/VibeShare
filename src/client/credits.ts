// Credits: the reports and claims a user's activity earns from the nodes — content ids
// played from outside the network, platform popularity numbers — and the log of what
// the user contributed (suggestions, submissions) the nodes pay for. One collaborator
// of ClientCore; browser-safe.
import type { ClaimResponse } from '../shared/protocol.js';
import { RemoteError } from '../shared/remote.js';
import { errorText } from './nodes.js';
import type { ClientCore } from './core.js';

/** Reports and claims the client's activity to the nodes, for one client. */
export class Credits {
  constructor(private readonly core: ClientCore) {}

  /**
   * Reports a content id or link the client played from outside the network to every
   * node that rewards such reports (algorithm nodes and content providers). Nodes that
   * already had the content keep it and pay nothing.
   */
  async report(id: string): Promise<{ nodes: { node: string; name: string; known?: boolean; credited?: number; error?: string }[] }> {
    const results = await Promise.all(
      [...this.core.nodes.active('algorithm'), ...this.core.nodes.active('provider')].map(async (entry) => {
        const client = this.core.nodes.client(entry);
        const started = Date.now();
        try {
          const result = await client.json<{ known: boolean; credited: number }>('/v1/reports', { body: { id } });
          this.core.traces.trace('dependency', 'core', 'POST /v1/reports', {
            message: entry.name,
            data: this.core.traces.summarize({ node: entry.id, url: `${client.url}/v1/reports`, method: 'POST', ms: Date.now() - started, credited: result.credited }),
          });
          return { node: entry.id, name: entry.name, ...result };
        } catch (error) {
          this.core.traces.trace('dependency', 'core', 'POST /v1/reports', {
            message: entry.name,
            data: this.core.traces.summarize({ node: entry.id, url: `${client.url}/v1/reports`, method: 'POST', ms: Date.now() - started, status: error instanceof RemoteError ? error.status : undefined }),
            error: errorText(error),
          });
          return { node: entry.id, name: entry.name, error: errorText(error) };
        }
      })
    );
    return { nodes: results };
  }

  /**
   * Reports platform popularity numbers (views, likes, comments, subscribers…) the
   * client saw for the content to every algorithm node; each pays for the numbers it
   * did not already have, times its per-source credit multipliers.
   */
  async claim(
    id: string,
    metrics: Record<string, number>,
    source?: string,
    publishedAt?: string
  ): Promise<{ nodes: { node: string; name: string; newInfo?: boolean; credited?: number; multiplier?: number; updated?: string[]; error?: string }[] }> {
    const results = await Promise.all(
      this.core.nodes.active('algorithm').map(async (entry) => {
        const client = this.core.nodes.client(entry);
        const started = Date.now();
        try {
          const result = await client.json<ClaimResponse>('/v1/claims', { body: { id, metrics, source, publishedAt } });
          this.core.traces.trace('dependency', 'core', 'POST /v1/claims', {
            message: entry.name,
            data: this.core.traces.summarize({ node: entry.id, url: `${client.url}/v1/claims`, method: 'POST', ms: Date.now() - started, credited: result.credited, multiplier: result.multiplier }),
          });
          return { node: entry.id, name: entry.name, ...result };
        } catch (error) {
          this.core.traces.trace('dependency', 'core', 'POST /v1/claims', {
            message: entry.name,
            data: this.core.traces.summarize({ node: entry.id, url: `${client.url}/v1/claims`, method: 'POST', ms: Date.now() - started, status: error instanceof RemoteError ? error.status : undefined }),
            error: errorText(error),
          });
          return { node: entry.id, name: entry.name, error: errorText(error) };
        }
      })
    );
    return { nodes: results };
  }
  async contributions() {
    const results = await Promise.all(
      this.core.nodes.list('algorithm').map(async (entry) => {
        try {
          const client = this.core.nodes.client(entry);
          const [suggestions, submissions] = await Promise.all([
            client.json<{ suggestions: unknown[] }>('/v1/suggestions/mine'),
            client.json<{ submissions: unknown[] }>('/v1/submissions/mine'),
          ]);
          return { node: entry.id, name: entry.name, ...suggestions, ...submissions };
        } catch (error) {
          return { node: entry.id, name: entry.name, suggestions: [], submissions: [], error: errorText(error) };
        }
      })
    );
    return { nodes: results };
  }
}
