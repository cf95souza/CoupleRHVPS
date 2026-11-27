import { Readable } from 'stream';

export type FileCategory =
  | 'AVATAR'
  | 'DOCUMENT'
  | 'PAYSLIP_PDF'
  | 'CERTIFICATE_A1'
  | 'REPORT'
  | 'AFD_FILE'
  | 'CONTRACT'
  | 'PUNCH_SELFIE'
  | 'MEDICAL_CERTIFICATE';

export interface StoredFileRecord {
  id: string;
  tenant_id: string | null;
  worker_id: string | null;
  category: FileCategory;
  original_name: string;
  mime_type: string;
  byte_size: number;
  sha256_hash: string;
  storage_rel_path: string;
  is_private: boolean;
  uploaded_by: string | null;
  deleted_at: Date | null;
  created_at: Date;
}

export interface IStorageAdapter {
  save(relPath: string, buffer: Buffer): Promise<void>;
  readStream(relPath: string): Readable;
  read(relPath: string): Promise<Buffer>;
  delete(relPath: string): Promise<void>;
  exists(relPath: string): Promise<boolean>;
  resolvePath(relPath: string): string;
}
