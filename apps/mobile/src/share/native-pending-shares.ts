import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';
import { recordLog } from '@/observability/log-buffer';

export interface NativeSharePayload {
  id: string;
  timestamp: number;
  type: string;
  text?: string;
  title?: string;
  file?: string;
  files?: string[];
  mimeType?: string;
}

export interface PendingShareRecord {
  payload: NativeSharePayload;
  filename: string;
}

/**
 * Reads any shares saved by the lightweight native ShareReceiverActivity.
 * The native side runs instantly without booting JS, saving payload here.
 */
export async function consumeNativePendingShares(): Promise<PendingShareRecord[]> {
  if (Platform.OS !== 'android') return [];

  try {
    const dir = new FileSystem.Directory(FileSystem.Paths.document, 'pending_shares');
    if (!dir.exists) return [];
    const items = dir.list();
    const shareFiles = items.filter(f => f.name.startsWith('share_') && f.name.endsWith('.json'));

    if (shareFiles.length === 0) {
      return [];
    }

    const shares: PendingShareRecord[] = [];

    for (const file of shareFiles) {
      if (file instanceof FileSystem.File) {
        try {
          const content = await file.text();
          shares.push({ payload: JSON.parse(content), filename: file.name });
        } catch (e) {
          recordLog('error', `[share] failed to consume native pending share ${file.name}: ${String(e)}`);
        }
      }
    }

    // Sort by timestamp so they are processed in order of receipt
    return shares.sort((a, b) => a.payload.timestamp - b.payload.timestamp);
  } catch (error) {
    recordLog('error', `[share] failed to list native pending shares: ${String(error)}`);
    return [];
  }
}

export async function deleteNativePendingShare(filename: string): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    const file = new FileSystem.File(FileSystem.Paths.document, 'pending_shares', filename);
    await file.delete();
  } catch (error) {
    recordLog('error', `[share] failed to delete native pending share ${filename}: ${String(error)}`);
  }
}
