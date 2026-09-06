// Inventory loading. Steam returns assets and descriptions as two flat lists
// that have to be joined on (appid, classid, instanceid).
import { COMMUNITY, SteamHttpError, steamRequest } from './http.js';

const IMAGE_BASE = 'https://community.cloudflare.steamstatic.com/economy/image';
const PAGE_SIZE = 2000;
const MAX_PAGES = 10; // 20k items is far beyond anything worth rendering on a phone

/** The games worth offering by default, with their inventory context ids. */
export const KNOWN_APPS = [
  { appid: 730, contextid: '2', name: 'Counter-Strike 2' },
  { appid: 570, contextid: '2', name: 'Dota 2' },
  { appid: 440, contextid: '2', name: 'Team Fortress 2' },
  { appid: 252490, contextid: '2', name: 'Rust' },
  { appid: 753, contextid: '6', name: 'Steam (cards, backgrounds)' },
  { appid: 232090, contextid: '2', name: 'Killing Floor 2' },
  { appid: 578080, contextid: '2', name: 'PUBG' },
];

export function itemImageUrl(iconUrl, size = '128fx128f') {
  if (!iconUrl) return null;
  return `${IMAGE_BASE}/${iconUrl}/${size}`;
}

function joinAssetsAndDescriptions(assets, descriptions, appid, contextid) {
  const lookup = new Map();
  for (const description of descriptions) {
    lookup.set(`${description.classid}_${description.instanceid}`, description);
  }

  const items = [];
  for (const asset of assets) {
    const description = lookup.get(`${asset.classid}_${asset.instanceid}`);
    if (!description) continue;

    items.push({
      key: `${appid}_${contextid}_${asset.assetid}`,
      appid: Number(appid),
      contextid: String(contextid),
      assetid: String(asset.assetid),
      classid: String(asset.classid),
      instanceid: String(asset.instanceid),
      amount: Number(asset.amount) || 1,
      name: description.name || 'Unknown item',
      marketName: description.market_name || description.name || '',
      marketHashName: description.market_hash_name || '',
      type: description.type || '',
      iconUrl: itemImageUrl(description.icon_url),
      nameColor: description.name_color ? `#${description.name_color}` : null,
      tradable: description.tradable === 1,
      marketable: description.marketable === 1,
      commodity: description.commodity === 1,
      tradeRestrictionDays: Number(description.market_tradable_restriction) || 0,
      tags: (description.tags || []).map((tag) => ({
        category: tag.category,
        name: tag.localized_tag_name || tag.name,
        color: tag.color ? `#${tag.color}` : null,
      })),
    });
  }
  return items;
}

/**
 * Load a full inventory, following Steam's pagination.
 *
 * @param {object} account signed-in account making the request
 * @param {{steamId?: string, appid: number, contextid: string, onProgress?: Function}} options
 */
export async function getInventory(account, { steamId, appid, contextid, onProgress }) {
  const owner = steamId || account.steamId;
  if (!owner) throw new SteamHttpError('No steamId available to load an inventory for');

  const items = [];
  let startAssetId;

  for (let page = 0; page < MAX_PAGES; page++) {
    const { data } = await steamRequest(account, `${COMMUNITY}/inventory/${owner}/${appid}/${contextid}`, {
      query: { l: 'english', count: String(PAGE_SIZE), start_assetid: startAssetId },
      referer: `${COMMUNITY}/profiles/${owner}/inventory`,
    });

    if (!data || data.success !== 1) {
      // Steam returns null with HTTP 200 for a private or empty inventory.
      if (data === null || data?.success === undefined) {
        throw new SteamHttpError(
          'Steam returned no inventory. It is either empty or the profile/inventory is set to private.'
        );
      }
      throw new SteamHttpError(data?.Error || data?.error || 'Steam refused to return the inventory');
    }

    items.push(...joinAssetsAndDescriptions(data.assets || [], data.descriptions || [], appid, contextid));
    if (onProgress) onProgress(items.length, Number(data.total_inventory_count) || items.length);

    if (!data.more_items || !data.last_assetid) break;
    startAssetId = data.last_assetid;
  }

  return items;
}

/** Group identical items so a 900-card inventory renders as a short list. */
export function groupItems(items) {
  const groups = new Map();
  for (const item of items) {
    const key = `${item.classid}_${item.instanceid}`;
    if (!groups.has(key)) groups.set(key, { ...item, key, items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()].map((group) => ({ ...group, count: group.items.length }));
}

/** Distinct values for a tag category, for the filter bar. */
export function collectTagValues(items, category) {
  const values = new Set();
  for (const item of items) {
    for (const tag of item.tags) {
      if (tag.category === category && tag.name) values.add(tag.name);
    }
  }
  return [...values].sort();
}
