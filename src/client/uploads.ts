import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { open, rm, stat } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomId } from '../shared/crypto.js';
import { HttpError, notFound } from '../shared/errors.js';
import type { UploadedFile, UploadStore } from './model.js';

const MAX_UPLOAD = 64 * 1024 * 1024 * 1024;

/** Files the GUI uploads for publishing, kept as temporary files until published. */
export class FileUploads implements UploadStore {
  private readonly dir: string;

  constructor(dataDir: string | null) {
    this.dir = join(dataDir ?? join(tmpdir(), 'vibeshare-client'), 'uploads');
    mkdirSync(this.dir, { recursive: true });
  }

  /** Receives a file from the GUI into a temporary file. */
  async receive(req: IncomingMessage): Promise<{ fileId: string; size: number }> {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_UPLOAD) throw new HttpError(413, 'too_large', 'File too large');
    const fileId = randomId('f', 10);
    const path = join(this.dir, fileId);
    await pipeline(req, createWriteStream(path));
    return { fileId, size: (await stat(path)).size };
  }

  async get(fileId: string): Promise<UploadedFile> {
    const path = join(this.dir, fileId);
    if (!/^f[a-z2-7]{16}$/.test(fileId) || !existsSync(path)) throw notFound('The uploaded file is gone; upload it again');
    const { size } = await stat(path);
    return {
      size,
      async read(offset, length) {
        const handle = await open(path, 'r');
        try {
          const buffer = Buffer.alloc(length);
          await handle.read(buffer, 0, length, offset);
          return buffer;
        } finally {
          await handle.close();
        }
      },
    };
  }

  async remove(fileId: string): Promise<void> {
    if (/^f[a-z2-7]{16}$/.test(fileId)) await rm(join(this.dir, fileId), { force: true });
  }
}
