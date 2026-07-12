export const APP_CONFIG_KEYS = ['min_app_version', 'latest_app_version', 'update_url', 'update_message'] as const;

export const DEFAULT_UPDATE_URL = 'https://play.google.com/store/apps/details?id=com.keepory.app';

export interface RemoteAppConfig {
  minAppVersion: string | null;
  latestAppVersion: string | null;
  updateUrl: string | null;
  updateMessage: string | null;
}

export interface AppConfigRow {
  key: string;
  value: string | null;
}

const EMPTY_CONFIG: RemoteAppConfig = {
  minAppVersion: null,
  latestAppVersion: null,
  updateUrl: null,
  updateMessage: null,
};

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function parseRemoteAppConfig(rows: AppConfigRow[]): RemoteAppConfig {
  const values = new Map(rows.map((row) => [row.key, clean(row.value)]));
  return {
    ...EMPTY_CONFIG,
    minAppVersion: values.get('min_app_version') ?? null,
    latestAppVersion: values.get('latest_app_version') ?? null,
    updateUrl: values.get('update_url') ?? null,
    updateMessage: values.get('update_message') ?? null,
  };
}
