import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { IStorageAdapter } from './IStorageAdapter.js';

export class LocalFsStorageAdapter implements IStorageAdapter {
  private readonly normalizedBasePath: string;

  constructor(private readonly basePath: string) {
    this.normalizedBasePath = path.resolve(this.basePath);
    if (!fs.existsSync(this.normalizedBasePath)) {
      fs.mkdirSync(this.normalizedBasePath, { recursive: true, mode: 0o750 });
    }
  }

  /**
   * Resolve o caminho relativo e impede qualquer tentativa de Path Traversal
   */
  public resolvePath(relPath: string): string {
    if (!relPath || typeof relPath !== 'string') {
      throw new Error('[STORAGE SECURITY] Caminho relativo de arquivo invalido ou ausente.');
    }

    // Remove caracteres nulos potencialmente maliciosos
    const sanitizedRel = relPath.replace(/\0/g, '');

    const resolved = path.resolve(this.normalizedBasePath, sanitizedRel);

    // Validação estrita: o arquivo precisa obrigatoriamente estar dentro do basePath
    if (!resolved.startsWith(this.normalizedBasePath + path.sep) && resolved !== this.normalizedBasePath) {
      throw new Error('[STORAGE SECURITY] Tentativa de violacao de acesso a diretorio detectada (Path Traversal).');
    }

    return resolved;
  }

  public async save(relPath: string, buffer: Buffer): Promise<void> {
    const fullPath = this.resolvePath(relPath);
    const dir = path.dirname(fullPath);

    await fs.promises.mkdir(dir, { recursive: true, mode: 0o750 });
    await fs.promises.writeFile(fullPath, buffer, { mode: 0o640 });
  }

  public readStream(relPath: string): Readable {
    const fullPath = this.resolvePath(relPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`[STORAGE ERROR] Arquivo nao encontrado no disco: ${relPath}`);
    }
    return fs.createReadStream(fullPath);
  }

  public async read(relPath: string): Promise<Buffer> {
    const fullPath = this.resolvePath(relPath);
    return await fs.promises.readFile(fullPath);
  }

  public async delete(relPath: string): Promise<void> {
    const fullPath = this.resolvePath(relPath);
    if (fs.existsSync(fullPath)) {
      await fs.promises.rm(fullPath, { force: true });
    }
  }

  public async exists(relPath: string): Promise<boolean> {
    try {
      const fullPath = this.resolvePath(relPath);
      await fs.promises.access(fullPath, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }
}
