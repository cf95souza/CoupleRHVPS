export const env = {
  API_URL: (import.meta.env.VITE_API_URL as string) || '',
  APP_PUBLIC_URL:
    (import.meta.env.VITE_APP_PUBLIC_URL as string) ||
    (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173'),
  ESOCIAL_ENVIRONMENT: (import.meta.env.VITE_ESOCIAL_ENVIRONMENT as string) || 'HOMOLOGATION',
  IS_PRODUCTION: import.meta.env.PROD,
};
