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

const getPendingSharesPath = () => {
  return `${FileSystem.Paths.document.uri}pending_shares.json`;
};

/**
 * Reads any shares saved by the lightweight native ShareReceiverActivity.
 * The native side runs instantly without booting JS, saving payload here.
 */
export async function consumeNativePendingShares(): Promise<NativeSharePayload[]> {
  if (Platform.OS !== 'android') return [];

  const path = getPendingSharesPath();
  
  try {
    const exists = await FileSystem.getInfoAsync(path);
    if (!exists.exists) {
      return [];
    }

    const content = await FileSystem.readAsStringAsync(path);
    const shares: NativeSharePayload[] = JSON.parse(content);

    // Clear the file so we don't process them again
    await FileSystem.writeAsStringAsync(path, '[]');
    
    if (shares.length > 0) {
      recordLog('info', `[share] consumed ${shares.length} offline native shares`);
    }
    
    return shares;
  } catch (error) {
    recordLog('error', `[share] failed to consume native pending shares: ${String(error)}`);
    return [];
  }
}
