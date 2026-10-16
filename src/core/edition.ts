// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Edition resolution — the ONE source of truth for which edition the server-side gates
 * honor. Every feature gate (enabledFeatures, room size, credential profiles, signature
 * providers) must derive from here so a single config knob flips the whole instance.
 *
 * Two independent inputs:
 *   - EUDI_EDITION=pro|community
 *       The edition this instance is configured/licensed as. Default: community.
 *   - EUDI_PROMO_ALL_PRO=true
 *       Unlock the FULL Pro feature set for EVERYONE, with no account or subscription
 *       gate. Unset it (or set =false) to fall back to the configured edition's gating.
 *
 * The EFFECTIVE edition (what the gates use) is `pro` when EITHER input asks for pro.
 * The CONFIGURED edition and the promo flag are reported separately by /capabilities so
 * it is always transparent WHY Pro is on: because it's licensed, or because of the promo.
 */
import type { Edition } from './features';

const truthy = (v: string | undefined): boolean => /^(1|true|yes|on)$/i.test((v || '').trim());

/** Promo active: give everyone the Pro feature set for free (no gate). */
export function promoAllPro(): boolean {
  return truthy(process.env.EUDI_PROMO_ALL_PRO);
}

/** The edition this instance is configured/licensed as (ignores the promo). */
export function configuredEdition(): Edition {
  return process.env.EUDI_EDITION === 'pro' ? 'pro' : 'community';
}

/** The edition the feature gates actually honor: promo forces `pro` for everyone. */
export function effectiveEdition(): Edition {
  return configuredEdition() === 'pro' || promoAllPro() ? 'pro' : 'community';
}
