// Background automation: auto-accepting trade offers and auto-confirming
// trades / market listings.
//
// Runs on a single timer that ticks every few seconds and asks each account
// whether it is due, rather than one timer per account. Steam rate-limits
// aggressively, so every account has its own interval and an error backoff.
import { fetchConfirmations, respondToConfirmations, selectAutoConfirmable } from '../steam/confirmations.js';
import { acceptTradeOffer, declineTradeOffer, getTradeOffers, TradeOfferState } from '../steam/trades.js';

const TICK_MS = 5000;
const MAX_BACKOFF_MS = 15 * 60 * 1000;

/**
 * Decide what to do with one received offer.
 * Pure and side-effect free so the policy is unit-testable on its own.
 *
 * @returns {'accept'|'decline'|'ignore'}
 */
export function decideOfferAction(offer, rules) {
  if (offer.direction !== 'received') return 'ignore';
  if (offer.state !== TradeOfferState.Active) return 'ignore';

  const trusted = (rules.trustedSteamIds || []).includes(offer.partnerSteamId);
  if (rules.acceptFromTrusted && trusted) return 'accept';

  // A "gift" is an offer where we give up nothing at all.
  if (rules.acceptGiftOffers && offer.itemsToGive.length === 0 && offer.itemsToReceive.length > 0) {
    return 'accept';
  }
  if (rules.declineOthers) return 'decline';
  return 'ignore';
}

export class AutomationEngine {
  /**
   * @param {object} hooks
   * @param {() => Array} hooks.getAccounts
   * @param {(account: object) => Promise<object>} hooks.ensureSession
   * @param {(entry: object) => void} hooks.onLog
   * @param {(title: string, body: string) => void} [hooks.onNotify]
   */
  constructor({ getAccounts, ensureSession, onLog, onNotify }) {
    this.getAccounts = getAccounts;
    this.ensureSession = ensureSession;
    this.onLog = onLog || (() => {});
    this.onNotify = onNotify || (() => {});
    this.timer = null;
    this.running = false;
    this.state = new Map(); // accountId -> { nextRunAt, failures, busy }
  }

  start() {
    if (this.timer) return;
    this.running = true;
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.log(null, 'error', `Automation tick failed: ${err.message}`));
    }, TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  isRunning() {
    return this.running;
  }

  /** Force the next tick to process this account immediately. */
  scheduleNow(accountId) {
    const entry = this.state.get(accountId);
    if (entry) entry.nextRunAt = 0;
  }

  stateFor(accountId) {
    if (!this.state.has(accountId)) this.state.set(accountId, { nextRunAt: 0, failures: 0, busy: false });
    return this.state.get(accountId);
  }

  async tick() {
    const now = Date.now();
    const due = this.getAccounts().filter((account) => {
      if (!account.automation?.enabled) return false;
      const entry = this.stateFor(account.id);
      return !entry.busy && now >= entry.nextRunAt;
    });

    // Sequential on purpose: parallel polling across accounts is a fast route
    // to a shared rate limit.
    for (const account of due) {
      const entry = this.stateFor(account.id);
      entry.busy = true;
      try {
        await this.runOnce(account);
        entry.failures = 0;
        entry.nextRunAt = Date.now() + account.automation.intervalSeconds * 1000;
      } catch (err) {
        entry.failures += 1;
        const backoff = Math.min(
          account.automation.intervalSeconds * 1000 * 2 ** entry.failures,
          MAX_BACKOFF_MS
        );
        entry.nextRunAt = Date.now() + backoff;
        this.log(account, 'error', err.message);
      } finally {
        entry.busy = false;
      }
    }
  }

  /** One full automation pass for a single account. */
  async runOnce(account) {
    const rules = account.automation;
    const live = await this.ensureSession(account);

    if (rules.acceptGiftOffers || rules.acceptFromTrusted || rules.declineOthers) {
      await this.processTradeOffers(live, rules);
    }
    if (rules.confirmTrades || rules.confirmMarket) {
      await this.processConfirmations(live, rules);
    }
  }

  async processTradeOffers(account, rules) {
    const { received } = await getTradeOffers(account, { activeOnly: true });

    for (const offer of received) {
      const action = decideOfferAction(offer, rules);
      if (action === 'ignore') continue;

      const summary = describeOffer(offer);
      try {
        if (action === 'accept') {
          await acceptTradeOffer(account, offer);
          this.log(account, 'accepted', `Accepted trade ${offer.id}: ${summary}`);
          if (rules.notify) this.onNotify(`${account.accountName}: trade accepted`, summary);
        } else {
          await declineTradeOffer(account, offer);
          this.log(account, 'declined', `Declined trade ${offer.id}: ${summary}`);
        }
      } catch (err) {
        this.log(account, 'error', `Trade ${offer.id}: ${err.message}`);
      }
    }
  }

  async processConfirmations(account, rules) {
    const confirmations = await fetchConfirmations(account);
    const actionable = selectAutoConfirmable(confirmations, {
      autoConfirmTrades: rules.confirmTrades,
      autoConfirmMarket: rules.confirmMarket,
    });
    if (actionable.length === 0) return;

    await respondToConfirmations(account, actionable, true);
    const description = actionable.map((c) => c.typeName).join(', ');
    this.log(account, 'confirmed', `Confirmed ${actionable.length}: ${description}`);
    if (rules.notify) {
      this.onNotify(`${account.accountName}: ${actionable.length} confirmed`, description);
    }
  }

  log(account, kind, message) {
    this.onLog({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: Date.now(),
      accountId: account?.id || null,
      accountName: account?.accountName || null,
      kind,
      message,
    });
  }
}

export function describeOffer(offer) {
  const give = offer.itemsToGive.length;
  const receive = offer.itemsToReceive.length;
  if (give === 0) return `receiving ${receive} item${receive === 1 ? '' : 's'} for nothing`;
  return `giving ${give}, receiving ${receive}`;
}
