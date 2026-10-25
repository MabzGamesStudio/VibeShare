import { randomId, signData } from '../shared/crypto.js';
import { buildManifest, contentIdOf, DEFAULT_CHUNK_SIZE, signManifest, validateManifest, type Manifest } from '../shared/content.js';
import type { ExternalPublishRequest, Job, JobStep, LibraryItem, NodeEntry, PublishPreview, PublishRequest } from '../shared/clientapi.js';
import { badRequest } from '../shared/errors.js';
import { claimSigningPayload, type SubmissionRequest } from '../shared/protocol.js';
import { formatSource, sourceFromUrl, withSources, parseSource } from '../shared/sources.js';
import { FORMATS, RATINGS, type Format, type Rating } from '../shared/taxonomy.js';
import type { ClientStoreLike, UploadedFile, UploadStore } from './model.js';
import { errorText, type NodeManager } from './nodes.js';
import { rememberPublished } from './published.js';

/** Reads a file a chunk at a time. */
async function* readChunks(file: UploadedFile, chunkSize: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < file.size; offset += chunkSize) yield file.read(offset, Math.min(chunkSize, file.size - offset));
}

/** Publishing: upload content to providers and submit its metadata to algorithm nodes. */
export class Publisher {
  readonly jobs = new Map<string, Job>();
  /** Settles when a job ends (lets service workers stay alive while publishing). */
  readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly store: ClientStoreLike,
    private readonly nodes: NodeManager,
    private readonly uploads: UploadStore
  ) {}

  private newJob(kind: Job['kind'], title: string, steps: string[]): Job {
    const job: Job = {
      id: randomId('job', 8),
      kind,
      title,
      status: 'running',
      progress: 0,
      steps: steps.map((label) => ({ label, status: 'waiting' })),
      startedAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    return job;
  }

  private nodesOf(ids: string[], type: 'provider' | 'algorithm'): NodeEntry[] {
    return ids.map((id) => this.nodes.require(id)).filter((node) => node.type === type);
  }

  private parseSources(list: string[] | undefined): string[] {
    return (list ?? [])
      .map((text) => text.trim())
      .filter(Boolean)
      .map((text) => {
        const source = parseSource(text) && !/^https?:/.test(text) ? parseSource(text) : sourceFromUrl(text);
        if (!source) throw badRequest(`Not a link or source: ${text}`);
        return formatSource(source);
      });
  }

  async publish(request: PublishRequest): Promise<Job> {
    if (!/^f[a-z2-7]{16}$/.test(String(request.fileId))) throw badRequest('Bad file id');
    const file = await this.uploads.get(request.fileId);
    if (!request.title?.trim()) throw badRequest('A title is required');
    const providers = this.nodesOf(request.providers ?? [], 'provider');
    const algorithms = this.nodesOf(request.algorithms ?? [], 'algorithm');
    if (!providers.length) throw badRequest('Pick at least one provider node to upload to');
    const sources = this.parseSources(request.sources);
    const job = this.newJob('publish', request.title, [
      'Split into chunks and hash',
      ...providers.map((node) => `Upload to ${node.name}`),
      ...algorithms.map((node) => `Submit to ${node.name}`),
    ]);
    this.track(job, this.runPublish(job, file, request, providers, algorithms, sources));
    return job;
  }

  /**
   * The manifest (and so the content id) an upload will have, computed here on the
   * client before anything is published. `publish` with the same request and this
   * manifest uploads exactly these chunks under exactly this id.
   */
  async preview(request: PublishRequest): Promise<PublishPreview> {
    if (!/^f[a-z2-7]{16}$/.test(String(request.fileId))) throw badRequest('Bad file id');
    const file = await this.uploads.get(request.fileId);
    if (!request.title?.trim()) throw badRequest('A title is required');
    const sources = this.parseSources(request.sources);
    const manifest = await this.buildManifest(file, request, sources);
    return {
      cid: contentIdOf(manifest),
      id: withSources(contentIdOf(manifest), sources.map((text) => parseSource(text)!)),
      manifest,
      size: manifest.size,
    };
  }

  /** Builds (and signs, when asked) the manifest of a file, exactly as publishing does. */
  private async buildManifest(file: UploadedFile, request: PublishRequest, sources: string[]): Promise<Manifest> {
    const format = FORMATS.includes(request.format as Format) ? (request.format as Format) : undefined;
    const rating = RATINGS.includes(request.rating as Rating) ? (request.rating as Rating) : undefined;
    let manifest: Manifest = await buildManifest(readChunks(file, DEFAULT_CHUNK_SIZE), {
      name: request.name || 'file',
      mime: request.mime || 'application/octet-stream',
      meta: {
        title: request.title.trim(),
        description: request.description?.trim() || undefined,
        format,
        rating,
        topics: request.topics?.length ? request.topics : undefined,
        tags: request.tags?.length ? request.tags : undefined,
        language: request.language || undefined,
        durationSeconds: request.durationSeconds,
      },
      sources,
      createdAt: request.createdAt,
    });
    const profile = this.store.data.data.settings.profile;
    if (request.sign) manifest = signManifest(manifest, this.store.identity, { name: profile.name || undefined, kind: profile.kind });
    validateManifest(manifest);
    return manifest;
  }

  private track(job: Job, task: Promise<void>): void {
    const done = task.finally(() => this.running.delete(job.id));
    this.running.set(job.id, done);
  }

  private async runPublish(
    job: Job,
    file: UploadedFile,
    request: PublishRequest,
    providers: NodeEntry[],
    algorithms: NodeEntry[],
    sources: string[]
  ): Promise<void> {
    const step = (index: number, status: JobStep['status'], detail?: string) => {
      job.steps[index].status = status;
      job.steps[index].detail = detail;
    };
    try {
      step(0, 'running');
      const format = FORMATS.includes(request.format as Format) ? (request.format as Format) : undefined;
      const rating = RATINGS.includes(request.rating as Rating) ? (request.rating as Rating) : undefined;
      // The manifest from the client's own preview is published as it is, so the content
      // id shown before the upload is exactly the id the content gets.
      let manifest: Manifest = request.manifest ? validateManifest(request.manifest) : await this.buildManifest(file, request, sources);
      if (manifest.size !== file.size) throw badRequest('The manifest does not match the uploaded file');
      const profile = this.store.data.data.settings.profile;
      const cid = contentIdOf(manifest);
      step(0, 'done', `${manifest.chunks.length} chunks`);
      const total = manifest.chunks.length * providers.length + algorithms.length || 1;
      let done = 0;
      const tick = () => {
        done++;
        job.progress = Math.min(1, done / total);
      };

      const stored: NodeEntry[] = [];
      {
        for (const [i, provider] of providers.entries()) {
          const index = 1 + i;
          step(index, 'running');
          try {
            const client = this.nodes.client(provider);
            const started = await client.json<{ cid: string; missing: string[]; cost: number }>('/v1/uploads', {
              body: { manifest },
              timeoutMs: 60000,
            });
            const missing = new Set(started.missing);
            for (const [chunkIndex, chunk] of manifest.chunks.entries()) {
              if (missing.has(chunk.id)) {
                const data = await file.read(chunkIndex * manifest.chunkSize, chunk.size);
                await client.fetch(`/v1/uploads/${cid}/chunks/${chunk.id}`, { method: 'PUT', raw: data, timeoutMs: 120000 });
                missing.delete(chunk.id);
              }
              tick();
            }
            await client.json(`/v1/uploads/${cid}/commit`, { method: 'POST', timeoutMs: 60000 });
            stored.push(provider);
            step(index, 'done', started.cost ? `${started.cost} credits` : undefined);
            void this.nodes.refreshBalance(provider);
          } catch (error) {
            step(index, 'error', errorText(error));
            done += manifest.chunks.length;
          }
        }
      }
      if (!stored.length) throw new Error('No provider node accepted the upload');

      const id = withSources(cid, sources.map((text) => parseSource(text)!));
      const library: LibraryItem = {
        id,
        title: request.title.trim(),
        mime: manifest.mime,
        size: manifest.size,
        publishedAt: new Date().toISOString(),
        providers: stored.map((node) => node.id),
        algorithms: [],
        native: true,
      };
      const submission: SubmissionRequest = {
        id,
        title: request.title.trim(),
        description: request.description?.trim() || undefined,
        format,
        rating,
        topics: request.topics,
        tags: request.tags,
        language: request.language || undefined,
        durationSeconds: request.durationSeconds,
        creator: request.sign ? { id: this.store.identity.id, name: profile.name || undefined, kind: profile.kind } : undefined,
        thumbnail: request.thumbnail,
        providers: stored.map((node) => node.ref),
        publishedAt: library.publishedAt,
      };
      await this.submitAll(job, 1 + providers.length, algorithms, submission, cid, request.sign, library, tick);
      this.store.data.data.library.unshift(library);
      this.store.changed();
      rememberPublished(this.store, id, library.title);
      job.result = { id };
      job.status = 'done';
      job.progress = 1;
      await this.uploads.remove(request.fileId);
    } catch (error) {
      job.status = 'error';
      job.error = errorText(error);
      const running = job.steps.find((s) => s.status === 'running');
      if (running) {
        running.status = 'error';
        running.detail = job.error;
      }
    }
  }

  private async submitAll(
    job: Job,
    firstStep: number,
    algorithms: NodeEntry[],
    submission: SubmissionRequest,
    base: string,
    sign: boolean,
    library: LibraryItem,
    tick: () => void
  ): Promise<void> {
    for (const [i, node] of algorithms.entries()) {
      const index = firstStep + i;
      job.steps[index].status = 'running';
      try {
        const client = this.nodes.client(node);
        const info = node.info ?? (await client.fetchInfo());
        const ts = Date.now();
        const body: SubmissionRequest = sign
          ? {
              ...submission,
              creatorProof: { key: this.store.identity.id, ts, sig: signData(this.store.identity, claimSigningPayload(info.id, base, ts)) },
            }
          : submission;
        const result = await client.json<{ id: string; status: string }>('/v1/submissions', { body, timeoutMs: 30000 });
        library.algorithms.push({ nodeId: node.id, submissionId: result.id });
        job.steps[index].status = 'done';
        job.steps[index].detail = result.status === 'accepted' ? 'Listed' : 'Waiting for review';
      } catch (error) {
        library.algorithms.push({ nodeId: node.id, error: errorText(error) });
        job.steps[index].status = 'error';
        job.steps[index].detail = errorText(error);
      }
      tick();
    }
  }

  /** Lists content hosted elsewhere (YouTube, archive.org, IPFS, any link) on algorithm nodes. */
  publishExternal(request: ExternalPublishRequest): Job {
    const source = sourceFromUrl(request.url ?? '');
    if (!source) throw badRequest('Not a link this client understands');
    if (!request.title?.trim()) throw badRequest('A title is required');
    const algorithms = this.nodesOf(request.algorithms ?? [], 'algorithm');
    if (!algorithms.length) throw badRequest('Pick at least one algorithm node');
    const id = formatSource(source);
    const job = this.newJob('external', request.title, algorithms.map((node) => `Submit to ${node.name}`));
    const format = FORMATS.includes(request.format as Format) ? (request.format as Format) : undefined;
    const rating = RATINGS.includes(request.rating as Rating) ? (request.rating as Rating) : undefined;
    const profile = this.store.data.data.settings.profile;
    const library: LibraryItem = {
      id,
      title: request.title.trim(),
      publishedAt: new Date().toISOString(),
      providers: [],
      algorithms: [],
      native: false,
    };
    const submission: SubmissionRequest = {
      id,
      title: request.title.trim(),
      description: request.description?.trim() || undefined,
      format,
      rating,
      topics: request.topics,
      tags: request.tags,
      language: request.language || undefined,
      creator: profile.name ? { name: profile.name, kind: profile.kind } : undefined,
      thumbnail: request.thumbnail,
      publishedAt: library.publishedAt,
    };
    let done = 0;
    const task = this.submitAll(job, 0, algorithms, submission, id, false, library, () => {
      done++;
      job.progress = done / algorithms.length;
    }).then(() => {
      this.store.data.data.library.unshift(library);
      this.store.changed();
      job.result = { id };
      job.status = library.algorithms.some((entry) => entry.submissionId) ? 'done' : 'error';
      if (job.status === 'done') rememberPublished(this.store, id, library.title);
      if (job.status === 'error') job.error = 'No algorithm node accepted the submission';
    });
    this.track(job, task);
    return job;
  }
}
