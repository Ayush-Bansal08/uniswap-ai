/**
 * build_transfer — unsigned native ETH or ERC-20 `transfer` (calldata via viem encodeFunctionData).
 */
import { encodeFunctionData, getAddress } from 'viem';
import { amountOf, toRaw } from '../amounts.js';
import { ZERO_ADDRESS } from '../chains.js';
import { erc20MetadataAbi } from '../clients/abis.js';
import { requireExecutionChain } from '../context.js';
import { invalidInput } from '../errors.js';
import { BuildResultSchema, BuildTransferInputSchema, type BuildResultObject } from '../schemas.js';
import { validateTx } from '../tx.js';
import { defineTool, short } from './define.js';

export const buildTransferTool = defineTool({
  name: 'build_transfer',
  title: 'Build an unsigned transfer',
  description:
    'Build an UNSIGNED transfer of native ETH or an ERC-20 (transfer(to, amount) calldata) on the execution chain. Never signs or broadcasts. Warns when the sender balance looks insufficient. Returns READY with one TRANSFER step.',
  kind: 'build',
  input: BuildTransferInputSchema,
  output: BuildResultSchema,
  async handler(args, deps): Promise<BuildResultObject> {
    requireExecutionChain(deps, args.chainId);
    const from = getAddress(args.from);
    const to = getAddress(args.to);
    if (to === ZERO_ADDRESS) throw invalidInput('Refusing to transfer to the zero address');
    const token = await deps.tokens.resolve(args.chainId, args.token);
    if (!token.isNative && to === getAddress(token.address)) {
      throw invalidInput('Refusing to transfer tokens to the token contract itself');
    }
    const raw = toRaw(args.amount, token.decimals);
    if (raw === 0n) throw invalidInput('amount must be greater than zero');

    const reader = deps.reader(args.chainId);
    const warnings: string[] = [];
    try {
      const balance = token.isNative
        ? await reader.getBalance(from)
        : (await reader.erc20Balances(from, [token.address as `0x${string}`]))[0] ?? 0n;
      if (balance < raw)
        warnings.push(
          `Sender balance ${amountOf(balance, token.decimals).decimal} ${
            token.symbol
          } is below the amount`
        );
    } catch {
      warnings.push('Could not read the sender balance');
    }
    if (to === from) warnings.push('Recipient equals sender');

    const step = token.isNative
      ? validateTx(
          'TRANSFER',
          `Send ${args.amount} ${token.symbol} to ${to}`,
          { to, from, data: '0x', value: raw.toString(), chainId: args.chainId },
          { chainId: args.chainId, from, allowedTo: [to], allowEmptyData: true }
        )
      : validateTx(
          'TRANSFER',
          `Send ${args.amount} ${token.symbol} to ${to}`,
          {
            to: token.address,
            from,
            data: encodeFunctionData({
              abi: erc20MetadataAbi,
              functionName: 'transfer',
              args: [to, raw],
            }),
            value: '0',
            chainId: args.chainId,
          },
          { chainId: args.chainId, from, allowedTo: [token.address] }
        );
    return {
      status: 'READY',
      steps: [step],
      summary: { tokenIn: token, amountIn: amountOf(raw, token.decimals), recipient: to },
      ...(warnings.length ? { warnings } : {}),
    };
  },
  summarize(o) {
    const s = o.summary;
    return `Transfer ${s.amountIn?.decimal} ${s.tokenIn?.symbol} to ${
      s.recipient ? short(s.recipient) : '?'
    } ready (1 unsigned tx)${o.warnings?.length ? `; warnings: ${o.warnings.join('; ')}` : ''}.`;
  },
});
