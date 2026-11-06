/**
 * Typed Uniswap LP API client (`/lp/*`) on https://liquidity.api.uniswap.org (no /v1 prefix —
 * LP guide "Base URL"; lp-integration skill "Base URL").
 *
 * Request/response shapes come from the same vendored OpenAPI contract (its /lp/* paths carry
 * a `servers` override to the LP host); the lp-integration skill marks the contract names as
 * authoritative over the narrative guide. Fields the skill documents but the spec lacks are
 * added below (`kycRequiredWarnings`).
 */
import createClient from 'openapi-fetch';
import type { components, paths } from '../generated/trading-api.js';
import type { FetchLike } from './http.js';
import { agentInfoHeader } from './tradingApi.js';
import { mapTransportError, mapUniswapError } from './uniswapErrors.js';

type S = components['schemas'];

export type LpApprovalRequest = S['LPApprovalRequest'];
export type KycRequiredWarning = { kycUrl: string; tokenAddress: string; chainId: number };
/** `kycRequiredWarnings` is documented in the lp-integration skill but missing from the spec. */
export type LpApprovalResponse = S['LPApprovalResponse'] & {
  kycRequiredWarnings?: KycRequiredWarning[];
};
export type CreatePositionRequest = S['CreatePositionRequest'];
export type CreatePositionResponse = S['CreatePositionResponse'] & { slippage?: number };
export type DecreasePositionRequest = S['DecreasePositionRequest'];
export type DecreasePositionResponse = S['DecreasePositionResponse'];
export type ClaimFeesRequest = S['ClaimFeesRequest'];
export type ClaimFeesResponse = S['ClaimFeesResponse'];
export type PoolInfoRequest = S['PoolInfoRequest'];
export type PoolInfoResponse = S['PoolInfoResponse'];
export type PoolInformation = S['PoolInformation'];
export type Permit = S['Permit'];

/** lp-integration SKILL.md metadata.version. */
export const LP_SKILL_VERSION = '0.1.0';

export interface LpApiOptions {
  baseUrl: string;
  apiKey: string;
  fetch: FetchLike;
  decisionOrigin: 'autonomous' | 'human_mediated';
}

export class LpApiClient {
  private readonly client;
  private readonly headers: Record<string, string>;

  constructor(options: LpApiOptions) {
    this.client = createClient<paths>({
      baseUrl: options.baseUrl,
      fetch: (request: Request) => options.fetch(request),
    });
    this.headers = {
      'x-api-key': options.apiKey,
      accept: 'application/json',
      'content-type': 'application/json',
      'x-agent-info': agentInfoHeader('lp-integration', options.decisionOrigin, LP_SKILL_VERSION),
    };
  }

  async checkApproval(body: LpApprovalRequest): Promise<LpApprovalResponse> {
    return (await this.call('/lp/check_approval', () =>
      this.client.POST('/lp/check_approval', { body, headers: this.headers })
    )) as LpApprovalResponse;
  }

  async create(body: CreatePositionRequest): Promise<CreatePositionResponse> {
    return (await this.call('/lp/create', () =>
      this.client.POST('/lp/create', { body, headers: this.headers })
    )) as CreatePositionResponse;
  }

  async decrease(body: DecreasePositionRequest): Promise<DecreasePositionResponse> {
    return (await this.call('/lp/decrease', () =>
      this.client.POST('/lp/decrease', { body, headers: this.headers })
    )) as DecreasePositionResponse;
  }

  async claimFees(body: ClaimFeesRequest): Promise<ClaimFeesResponse> {
    return (await this.call('/lp/claim_fees', () =>
      this.client.POST('/lp/claim_fees', { body, headers: this.headers })
    )) as ClaimFeesResponse;
  }

  async poolInfo(body: PoolInfoRequest): Promise<PoolInfoResponse> {
    return (await this.call('/lp/pool_info', () =>
      this.client.POST('/lp/pool_info', { body, headers: this.headers })
    )) as PoolInfoResponse;
  }

  private async call(
    path: string,
    run: () => Promise<{ data?: unknown; error?: unknown; response: Response }>
  ): Promise<unknown> {
    const api = `Uniswap LP API ${path}`;
    let result: { data?: unknown; error?: unknown; response: Response };
    try {
      result = await run();
    } catch (err) {
      throw mapTransportError(api, err);
    }
    if (!result.response.ok || result.data === undefined) {
      throw mapUniswapError(api, result.response.status, result.error);
    }
    return result.data;
  }
}
