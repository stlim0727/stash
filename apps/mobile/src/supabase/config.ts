declare const process: { env?: Record<string, string | undefined> };

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

export type SupabaseConfigState =
  | { status: 'configured'; config: SupabaseConfig }
  | { status: 'missing'; missing: Array<keyof SupabaseConfig> };

const SUPABASE_URL_ENV = 'EXPO_PUBLIC_SUPABASE_URL';
const SUPABASE_ANON_KEY_ENV = 'EXPO_PUBLIC_SUPABASE_ANON_KEY';

function readPublicEnv(key: string): string {
  return process.env?.[key]?.trim() ?? '';
}

export function getSupabaseConfigState(): SupabaseConfigState {
  const url = readPublicEnv(SUPABASE_URL_ENV);
  const anonKey = readPublicEnv(SUPABASE_ANON_KEY_ENV);
  const missing: Array<keyof SupabaseConfig> = [];

  if (!url) {
    missing.push('url');
  }
  if (!anonKey) {
    missing.push('anonKey');
  }

  if (missing.length > 0) {
    return { status: 'missing', missing };
  }

  return {
    status: 'configured',
    config: {
      url: url.replace(/\/$/, ''),
      anonKey,
    },
  };
}

export function describeSupabaseConfig(state = getSupabaseConfigState()): string {
  if (state.status === 'configured') {
    return 'Configured from Expo public environment';
  }

  const names = state.missing.map((key) =>
    key === 'url' ? SUPABASE_URL_ENV : SUPABASE_ANON_KEY_ENV,
  );
  return `Missing ${names.join(', ')}`;
}
