import { TOOL_NAMES } from '../schemas.js';
import { buildLpExitTool } from './build_lp_exit.js';
import { buildLpPositionTool } from './build_lp_position.js';
import { buildRebalanceTool } from './build_rebalance.js';
import { buildSwapTool } from './build_swap.js';
import { buildTransferTool } from './build_transfer.js';
import { checkTokenTool } from './check_token.js';
import { comparePoolsTool } from './compare_pools.js';
import type { ToolDefinition } from './define.js';
import { getHookStateTool } from './get_hook_state.js';
import { getLpPositionsTool } from './get_lp_positions.js';
import { getPortfolioTool } from './get_portfolio.js';
import { getPriceHistoryTool } from './get_price_history.js';
import { getQuoteTool } from './get_quote.js';
import { listNewHooksTool } from './list_new_hooks.js';
import { planTriggerTool } from './plan_trigger.js';
import { quotePoolTool } from './quote_pool.js';
import { scoreHookTool } from './score_hook.js';

/** All 16 tools, in the documented order. */
export const TOOLS: readonly ToolDefinition[] = [
  getQuoteTool,
  quotePoolTool,
  getPortfolioTool,
  getPriceHistoryTool,
  getLpPositionsTool,
  comparePoolsTool,
  checkTokenTool,
  listNewHooksTool,
  scoreHookTool,
  getHookStateTool,
  buildSwapTool,
  buildTransferTool,
  buildLpPositionTool,
  buildLpExitTool,
  buildRebalanceTool,
  planTriggerTool,
] as unknown as readonly ToolDefinition[];

// Guard against drift between the registry and the published name list.
if (TOOLS.length !== TOOL_NAMES.length || TOOLS.some((t, i) => t.name !== TOOL_NAMES[i])) {
  throw new Error('Tool registry does not match TOOL_NAMES');
}
