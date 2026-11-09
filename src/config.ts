const getEnv = (key: string, defaultValue?: string): string => {
  const value = process.env[key] ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

const getEnvInt = (key: string, defaultValue: number): number => {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be an integer, got: ${raw}`);
  }
  return parsed;
};

export const config = {
  port: getEnvInt('PORT', 5000),
  nodeEnv: getEnv('NODE_ENV', 'development'),
  jwtSharedSecret: getEnv('JWT_SHARED_SECRET', 'distributed-ctf-jwt-secret-shared-across-vms-2026!'),
  databaseUrl: getEnv('DATABASE_URL', 'postgresql://ctf_admin:SuperSecretCtfPass123!@192.168.200.14:5432/ctf_db'),
  vm5DockerHost: getEnv('VM5_DOCKER_HOST', 'tcp://192.168.200.15:2375'),
  vm5TraefikNetwork: getEnv('VM5_TRAEFIK_NETWORK', 'traefik_net'),
  ctfDomain: getEnv('CTF_DOMAIN', 'ctf.local'),
  instanceTtlMinutes: getEnvInt('INSTANCE_TTL_MINUTES', 60),
  authServiceUrl: getEnv('AUTH_SERVICE_URL', 'http://192.168.200.11:4000'),
  corsOrigins: getEnv('CORS_ORIGINS', 'http://192.168.200.12:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
} as const;

export type Config = typeof config;
