/**
 * Centralized ABI loader for LazyLotto contracts.
 * Uses createRequire for CJS interop — loaded once, exported as typed references.
 */

import { createRequire } from 'node:module';

const esmRequire = createRequire(import.meta.url);
const lazyLotto = esmRequire('@lazysuperheroes/lazy-lotto');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AbiFragment = any;

/** LazyLotto main contract ABI. */
export const LazyLottoABI: AbiFragment[] = lazyLotto.LazyLottoABI;

/** LazyDelegateRegistry contract ABI. */
export const LazyDelegateRegistryABI: AbiFragment[] = lazyLotto.LazyDelegateRegistryABI;
