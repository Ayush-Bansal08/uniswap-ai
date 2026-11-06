/**
 * Loads the Uniswap SDKs through their CommonJS builds.
 *
 * `@uniswap/v4-sdk@2.4.1`'s ESM build uses directory imports (`export * from './entities'`),
 * which Node's ESM loader rejects with ERR_UNSUPPORTED_DIR_IMPORT (see FEEDBACK.md). The CJS
 * build is correct, so we `require` it and keep full typing via `import type`.
 */
import { createRequire } from 'node:module';
import type * as SdkCore from '@uniswap/sdk-core';
import type * as V3Sdk from '@uniswap/v3-sdk';
import type * as V4Sdk from '@uniswap/v4-sdk';

const require = createRequire(import.meta.url);

export const v4: typeof V4Sdk = require('@uniswap/v4-sdk');
export const core: typeof SdkCore = require('@uniswap/sdk-core');
export const v3: typeof V3Sdk = require('@uniswap/v3-sdk');
