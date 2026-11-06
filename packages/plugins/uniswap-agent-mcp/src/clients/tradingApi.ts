/**
 * Typed Uniswap Trading API client (`/check_approval`, `/quote`, `/swap`), generated from
 * docs/vendor/uniswap-trading-openapi.json (`pnpm gen:api` → src/generated/trading-api.ts).
 *
 * Headers per the swap-integration skill ("Required Headers" / "Agent Attribution"):
 *   x-api-key, x-universal-router-version (2.1.2 — 2.0 was sunset on 2026-10-21 per the
 *   supported-chains doc), and x-agent-info with exactly integration_name/decision_origin/version.
 */
import createClient from 'openapi-fetch';
import type { components, paths } from '../generated/trading-api.js';
import type { FetchLike } from './http.js';
import { mapTransportError, mapUniswapError } from './uniswapErrors.js';

export type Schemas = components['schemas'];
export type QuoteRequest = Schemas['QuoteRequest'];
export type QuoteResponse = Schemas['QuoteResponse'];
export type ClassicQuote = Schemas['ClassicQuote'];
export type ApprovalRequest = Schemas['ApprovalRequest'];
export type ApprovalResponse = Schemas['ApprovalResponse'];
type DefaultedSwapFields = 'includeGasInfo' | 'refreshGasPrice' | 'simulateTransaction';
/** Fields with spec defaults are optional on the wire (openapi-typescript marks them required). */
export type CreateSwapRequest = Omit<Schemas['CreateSwapRequest'], DefaultedSwapFields> &
  Partial<Pick<Schemas['CreateSwapRequest'], DefaultedSwapFields>>;
export type Permit = Schemas['Permit'];
export type CreateSwapResponse = Schemas['CreateSwapResponse'];
export type UniswapTransactionRequest = Schemas['TransactionRequest'];
export type UniversalRouterVersion = Schemas['UniversalRouterVersion'];

/** Skill version this integration follows (swap-integration SKILL.md metadata.version). */
export const SWAP_SKILL_VERSION = '1.6.0';

export interface TradingApiOptions {
  baseUrl: string;
  apiKey: string;
  fetch: FetchLike;
  universalRouterVersion: UniversalRouterVersion;
  decisionOrigin: 'autonomous' | 'human_mediated';
}

export function agentInfoHeader(
  integrationName: string,
  decisionOrigin: 'autonomous' | 'human_mediated',
  version: string
): string {
  // Exactly three fields, plain ASCII, < 1 KB (skill "Constraints").
  return JSON.stringify({
    integration_name: integrationName,
    decision_origin: decisionOrigin,
    version,
  });
}

export class TradingApiClient {
  private readonly client;
  private readonly headers: Record<string, string>;

  constructor(private readonly options: TradingApiOptions) {
    this.client = createClient<paths>({
      baseUrl: options.baseUrl,
      fetch: (request: Request) => options.fetch(request),
    });
    this.headers = {
      'x-api-key': options.apiKey,
      accept: 'application/json',
      'content-type': 'application/json',
      'x-universal-router-version': options.universalRouterVersion,
      'x-agent-info': agentInfoHeader(
        'swap-integration',
        options.decisionOrigin,
        SWAP_SKILL_VERSION
      ),
    };
  }

  get universalRouterVersion(): UniversalRouterVersion {
    return this.options.universalRouterVersion;
  }

  async checkApproval(body: ApprovalRequest): Promise<ApprovalResponse> {
    const result = await this.call('/check_approval', () =>
      this.client.POST('/check_approval', { body, headers: this.headers })
    );
    return result as ApprovalResponse;
  }

  async quote(body: QuoteRequest): Promise<QuoteResponse> {
    const result = await this.call('/quote', () =>
      this.client.POST('/quote', { body, headers: this.headers })
    );
    return result as QuoteResponse;
  }

  async swap(body: CreateSwapRequest): Promise<CreateSwapResponse> {
    const result = await this.call('/swap', () =>
      this.client.POST('/swap', {
        body: body as Schemas['CreateSwapRequest'],
        headers: this.headers,
      })
    );
    return result as CreateSwapResponse;
  }

  private async call(
    path: string,
    run: () => Promise<{ data?: unknown; error?: unknown; response: Response }>
  ): Promise<unknown> {
    const api = `Uniswap Trading API ${path}`;
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
