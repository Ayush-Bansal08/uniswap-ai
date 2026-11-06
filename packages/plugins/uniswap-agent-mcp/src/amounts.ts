/** Human ↔ raw amount conversion that never rounds silently. */
import { Decimal as DecimalLib } from 'decimal.js';
import { formatUnits } from 'viem';
import { invalidInput } from './errors.js';
import type { Amount } from './schemas.js';

/** Private Decimal constructor (a clone, so host apps' global decimal.js config is untouched). */
export const Decimal = DecimalLib.clone({
  precision: 60,
  rounding: DecimalLib.ROUND_HALF_UP,
  toExpNeg: -40,
  toExpPos: 60,
});
export type Decimal = DecimalLib;

/** Parse a human decimal string into base units. Rejects more decimals than the token has. */
export function toRaw(amount: string, decimals: number, label = 'amount'): bigint {
  const trimmed = amount.trim();
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(trimmed)) {
    throw invalidInput(`${label} "${amount}" is not a non-negative decimal number`);
  }
  const [whole = '0', fraction = ''] = trimmed.split('.');
  const fractionTrimmed = fraction.replace(/0+$/, '');
  if (fractionTrimmed.length > decimals) {
    throw invalidInput(
      `${label} "${amount}" has more than ${decimals} decimal places for this token`
    );
  }
  return (
    BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fractionTrimmed.padEnd(decimals, '0') || '0')
  );
}

export function fromRaw(raw: bigint | string, decimals: number): string {
  const value = typeof raw === 'string' ? BigInt(raw) : raw;
  if (value < 0n) throw new RangeError('Negative raw amount');
  return formatUnits(value, decimals);
}

export function amountOf(raw: bigint | string, decimals: number): Amount {
  const value = typeof raw === 'string' ? BigInt(raw) : raw;
  return { raw: value.toString(), decimal: fromRaw(value, decimals) };
}

/** USD value of a human amount at a USD price, as a 2+ decimal string (display precision 6). */
export function usdValue(amountDecimal: string, priceUsd: string): string {
  return new Decimal(amountDecimal).mul(priceUsd).toDecimalPlaces(6).toFixed();
}

export function sumDecimals(values: readonly string[]): string {
  return values
    .reduce((acc, v) => acc.plus(v), new Decimal(0))
    .toDecimalPlaces(6)
    .toFixed();
}

/** Format a USD price for humans: "$3,312.40". */
export function formatUsd(value: string | Decimal): string {
  const d = new Decimal(value);
  const decimals = d.abs().lt(1) ? 4 : 2;
  const [int, frac] = d.toFixed(decimals).split('.');
  const withCommas = (int ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `$${withCommas}${frac ? `.${frac}` : ''}`;
}
