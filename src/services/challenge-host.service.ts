import axios from 'axios';
import { config } from '../config';
import { dockerService } from './docker.service';

export interface ProvisionResponse {
  vmid?: number | null;
  proxmoxNode?: string | null;
  ipAddress?: string | null;
  hostUrl: string;
  connectionUrl?: string | null;
  containerId: string;
  containerName: string;
  subdomain: string;
  internalPort: number;
  runtimeType: string;
}

export class ChallengeHostService {
  private baseUrl: string;

  constructor() {
    this.baseUrl = config.challengeHostUrl.replace(/\/+$/, '');
  }

  /**
   * Delegates provisioning of Proxmox CT/VM or Docker container to ChallengeHoste (VM 5, 192.168.200.15:5050)
   */
  async provision(
    userId: string,
    username: string,
    challenge: {
      id: string;
      slug: string;
      name: string;
      runtimeType: string;
      proxmoxNode: string;
      templateId: number;
      cpuCores: number;
      ramMB: number;
      diskGB: number;
      storagePool: string;
      connectionType: string;
      dockerImage: string;
      internalPort: number;
    }
  ): Promise<ProvisionResponse> {
    try {
      console.log(`[ChallengeHostService] Forwarding provision request to ChallengeHoste at ${this.baseUrl}...`);
      const response = await axios.post<ProvisionResponse>(
        `${this.baseUrl}/api/provision`,
        {
          userId,
          username,
          challenge,
        },
        { timeout: 45000 }
      );

      return response.data;
    } catch (err: any) {
      console.warn(
        `[ChallengeHostService] ChallengeHoste API call failed (${err?.message}). Attempting Docker fallback if applicable...`
      );

      // Fall back to direct Docker if:
      // 1. Challenge runtimeType is DOCKER (or undefined)
      // 2. ChallengeHoste orchestrator returned HTTP 5xx (e.g. Proxmox down/misconfigured) or is unreachable (ECONNREFUSED/ETIMEDOUT)
      //    AND the challenge has a dockerImage configured.
      const isNetworkOrServerError =
        err?.code === 'ECONNREFUSED' ||
        err?.code === 'ETIMEDOUT' ||
        err?.code === 'ENOTFOUND' ||
        (err?.response?.status != null && err.response.status >= 500);

      const isDockerFallback =
        challenge.runtimeType === 'DOCKER' ||
        !challenge.runtimeType ||
        (isNetworkOrServerError && Boolean(challenge.dockerImage));

      if (isDockerFallback && challenge.dockerImage) {
        console.warn('[ChallengeHostService] Falling back to direct Docker provisioning...');
        const fallback = await dockerService.spawnInstance(
          userId,
          username,
          challenge.id,
          challenge.dockerImage,
          challenge.internalPort
        );

        return {
          vmid: null,
          proxmoxNode: null,
          ipAddress: '192.168.200.15',
          hostUrl: fallback.hostUrl,
          connectionUrl: fallback.hostUrl,
          containerId: fallback.containerId,
          containerName: fallback.containerName,
          subdomain: fallback.subdomain,
          internalPort: challenge.internalPort,
          runtimeType: 'DOCKER',
        };
      }

      throw new Error(
        `ChallengeHoste provisioning error: ${err?.response?.data?.details || err?.response?.data?.error || err?.message}`
      );
    }
  }

  /**
   * Delegates deprovisioning of an instance to ChallengeHoste (stops & deletes VM/CT or Docker container)
   */
  async deprovision(params: {
    vmid?: number | null;
    proxmoxNode?: string | null;
    runtimeType?: string;
    containerId?: string | null;
    containerName?: string | null;
  }): Promise<void> {
    try {
      await axios.post(`${this.baseUrl}/api/deprovision`, params, { timeout: 20000 });
    } catch (err: any) {
      console.warn(`[ChallengeHostService] Deprovision call to ChallengeHoste failed: ${err?.message}`);
      // Fallback: try dockerService destroy directly if containerId exists
      if (params.containerId && !params.vmid) {
        try {
          await dockerService.destroyInstance(params.containerId);
        } catch (dockErr) {
          // ignore
        }
      }
    }
  }
}

export const challengeHostService = new ChallengeHostService();
