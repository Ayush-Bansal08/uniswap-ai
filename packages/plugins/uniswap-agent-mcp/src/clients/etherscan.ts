/**
 * Optional Etherscan v2 (multichain) lookups: verified source and contract creation block.
 * Without ETHERSCAN_API_KEY every method returns null ("unknown"), never an error.
 */
import type { FetchLike } from './http.js';

export interface SourceInfo {
  verified: boolean;
  contractName: string | null;
  isProxy: boolean;
  implementation: string | null;
}

export interface CreationInfo {
  blockNumber: bigint | null;
  timestamp: number | null;
}

export class EtherscanClient {
  constructor(
    private readonly options: { baseUrl: string; apiKey: string | undefined; fetch: FetchLike }
  ) {}

  get configured(): boolean {
    return !!this.options.apiKey;
  }

  private async get(params: Record<string, string>): Promise<unknown[] | null> {
    if (!this.options.apiKey) return null;
    const url = new URL(this.options.baseUrl);
    for (const [k, v] of Object.entries({ ...params, apikey: this.options.apiKey })) {
      url.searchParams.set(k, v);
    }
    try {
      const response = await this.options.fetch(url.toString(), { method: 'GET' });
      if (!response.ok) return null;
      const body = (await response.json()) as { status?: string; result?: unknown };
      if (body.status !== '1' || !Array.isArray(body.result)) return null;
      return body.result;
    } catch {
      return null;
    }
  }

  async sourceInfo(chainId: number, address: string): Promise<SourceInfo | null> {
    const result = await this.get({
      chainid: String(chainId),
      module: 'contract',
      action: 'getsourcecode',
      address,
    });
    const first = result?.[0] as
      | { SourceCode?: string; ContractName?: string; Proxy?: string; Implementation?: string }
      | undefined;
    if (!first) return null;
    return {
      verified: typeof first.SourceCode === 'string' && first.SourceCode.trim().length > 0,
      contractName: first.ContractName?.trim() || null,
      isProxy: first.Proxy === '1',
      implementation: first.Implementation?.trim() || null,
    };
  }

  async creation(chainId: number, address: string): Promise<CreationInfo | null> {
    const result = await this.get({
      chainid: String(chainId),
      module: 'contract',
      action: 'getcontractcreation',
      contractaddresses: address,
    });
    const first = result?.[0] as { blockNumber?: string; timestamp?: string } | undefined;
    if (!first) return null;
    return {
      blockNumber:
        first.blockNumber && /^\d+$/.test(first.blockNumber) ? BigInt(first.blockNumber) : null,
      timestamp: first.timestamp && /^\d+$/.test(first.timestamp) ? Number(first.timestamp) : null,
    };
  }
}
