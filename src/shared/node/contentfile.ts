import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { buildManifest, DEFAULT_CHUNK_SIZE, type BuildOptions, type Manifest } from './content.js';

/** Builds the manifest of a file on disk, reading it once. */
export async function buildManifestFromFile(
  path: string,
  options: BuildOptions,
  onChunk?: (id: string, data: Buffer, index: number) => Promise<void> | void
): Promise<Manifest> {
  await stat(path);
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  return buildManifest(createReadStream(path, { highWaterMark: chunkSize }), options, onChunk);
}
