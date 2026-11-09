import Docker from 'dockerode';
import { config } from '../config';

interface ParsedDockerHost {
  host: string;
  port: number;
  protocol: 'http' | 'https';
}

function parseDockerHost(hostStr: string): ParsedDockerHost {
  // e.g. tcp://192.168.200.15:2375
  const url = new URL(hostStr.replace('tcp://', 'http://'));
  return {
    host: url.hostname,
    port: parseInt(url.port, 10) || 2375,
    protocol: 'http',
  };
}

interface SpawnResult {
  containerId: string;
  containerName: string;
  subdomain: string;
  hostUrl: string;
}

interface ContainerStats {
  cpuPercent: number;
  memoryMB: number;
  memoryLimitMB: number;
}

class DockerService {
  private docker: Docker;

  constructor() {
    const { host, port, protocol } = parseDockerHost(config.vm5DockerHost);
    this.docker = new Docker({ host, port, protocol });
  }

  /**
   * Sanitize a string to be a valid subdomain label (lowercase alphanumeric and dash).
   */
  private sanitizeSubdomain(input: string): string {
    return input
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 63);
  }

  async spawnInstance(
    userId: string,
    username: string,
    challengeId: string,
    challengeImage: string,
    internalPort: number,
  ): Promise<SpawnResult> {
    const rawSubdomain = `${username}-${challengeId.slice(0, 8)}`;
    const subdomain = this.sanitizeSubdomain(rawSubdomain);
    const containerName = `ctf-${subdomain}`;
    const { ctfDomain, vm5TraefikNetwork } = config;
    const hostUrl = `http://${subdomain}.${ctfDomain}`;

    const labels: Record<string, string> = {
      'traefik.enable': 'true',
      [`traefik.http.routers.${containerName}.rule`]: `Host(\`${subdomain}.${ctfDomain}\`)`,
      [`traefik.http.routers.${containerName}.entrypoints`]: 'web',
      [`traefik.http.services.${containerName}.loadbalancer.server.port`]: String(internalPort),
      'traefik.docker.network': vm5TraefikNetwork,
    };

    const container = await this.docker.createContainer({
      Image: challengeImage,
      name: containerName,
      Labels: labels,
      HostConfig: {
        RestartPolicy: { Name: 'unless-stopped' },
        Memory: 512 * 1024 * 1024, // 512 MB
        CpuQuota: 50000, // 50% of one core (period default is 100000)
        NetworkMode: vm5TraefikNetwork,
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [vm5TraefikNetwork]: {},
        },
      },
    });

    await container.start();

    const info = await container.inspect();
    const containerId = info.Id;

    return { containerId, containerName, subdomain, hostUrl };
  }

  async destroyInstance(containerId: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerId);
      try {
        await container.stop({ t: 10 });
      } catch (stopErr: unknown) {
        const msg = stopErr instanceof Error ? stopErr.message : String(stopErr);
        // Ignore "already stopped" and "no such container" errors
        if (!msg.includes('container already stopped') && !msg.includes('No such container')) {
          console.warn(`[DockerService] Warning stopping container ${containerId}:`, msg);
        }
      }
      await container.remove({ force: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('No such container') || msg.includes('no such container')) {
        // Container is already gone — that's fine
        return;
      }
      throw err;
    }
  }

  async getContainerStats(containerId: string): Promise<ContainerStats | null> {
    try {
      const container = this.docker.getContainer(containerId);
      const stats = (await container.stats({ stream: false })) as Docker.ContainerStats;

      // CPU percentage calculation
      const cpuDelta =
        stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
      const systemDelta =
        stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
      const numCpus = stats.cpu_stats.online_cpus ?? stats.cpu_stats.cpu_usage.percpu_usage?.length ?? 1;
      const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : 0;

      const memoryMB = stats.memory_stats.usage / (1024 * 1024);
      const memoryLimitMB = stats.memory_stats.limit / (1024 * 1024);

      return {
        cpuPercent: Math.round(cpuPercent * 100) / 100,
        memoryMB: Math.round(memoryMB * 100) / 100,
        memoryLimitMB: Math.round(memoryLimitMB * 100) / 100,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('No such container') ||
        msg.includes('no such container') ||
        msg.includes('is not running')
      ) {
        return null;
      }
      console.error(`[DockerService] Error getting stats for ${containerId}:`, err);
      return null;
    }
  }

  async ensureImage(image: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) {
          reject(err);
          return;
        }
        this.docker.modem.followProgress(stream, (followErr: Error | null) => {
          if (followErr) {
            reject(followErr);
          } else {
            resolve();
          }
        });
      });
    });
  }

  async listRunningContainers(): Promise<Docker.ContainerInfo[]> {
    return this.docker.listContainers({ all: false });
  }
}

export const dockerService = new DockerService();
