#!/usr/bin/env node

import http from 'node:http';
import { URL } from 'node:url';
import { ProviderFactory, ProviderName } from './providers';
import type { GroceryProvider, SearchOptions } from './providers/types';

type FavouritesProvider = GroceryProvider & {
  getFavourites?: (options?: SearchOptions) => Promise<unknown[]>;
  searchFavourites?: (query: string, options?: SearchOptions) => Promise<unknown[]>;
};

const host = process.env.GROC_API_HOST || '127.0.0.1';
const port = parsePort(process.env.GROC_API_PORT || '7876');
const defaultProvider = (process.env.GROC_PROVIDER || 'sainsburys') as ProviderName;
const apiToken = process.env.GROC_API_TOKEN;
const loginAttempts = new Map<string, Promise<void>>();

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid GROC_API_PORT: ${value}`);
  }
  return parsed;
}

function parsePositiveInt(value: string | null, name: string, defaultValue: number): number {
  if (value === null || value === '') return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

function getProvider(url: URL): GroceryProvider {
  const providerName = (url.searchParams.get('provider') || defaultProvider) as ProviderName;
  return ProviderFactory.create(providerName);
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function requireQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw Object.assign(new Error(`Missing query parameter: ${name}`), { statusCode: 400 });
  return value;
}

function checkAuth(req: http.IncomingMessage): boolean {
  if (!apiToken) return true;
  return req.headers.authorization === `Bearer ${apiToken}`;
}

function isProviderAuthError(error: any): boolean {
  const status = error?.response?.status ?? error?.status ?? error?.statusCode;
  if (status === 401) return true;
  return /\b401\b|unauthori[sz]ed|session expired|not logged in/i.test(error?.message || '');
}

function getLoginCredentials(providerName: ProviderName): { email?: string; password?: string } {
  const prefix = providerName.toUpperCase();
  return {
    email: process.env[`${prefix}_EMAIL`] || process.env.GROC_EMAIL,
    password: process.env[`${prefix}_PASSWORD`] || process.env.GROC_PASSWORD,
  };
}

function kickOffLogin(providerName: ProviderName): void {
  if (loginAttempts.has(providerName)) {
    console.log(`Login already in progress for ${providerName}`);
    return;
  }

  const { email, password } = getLoginCredentials(providerName);
  if (!email || !password) {
    console.error(
      `Cannot auto-login to ${providerName}: set GROC_EMAIL/GROC_PASSWORD or ${providerName.toUpperCase()}_EMAIL/${providerName.toUpperCase()}_PASSWORD`
    );
    return;
  }

  console.log(`No session or session expired for ${providerName}; starting background login...`);
  const attempt = ProviderFactory.create(providerName)
    .login(email, password)
    .then(() => {
      console.log(`Background login to ${providerName} completed`);
    })
    .catch((error: any) => {
      console.error(`Background login to ${providerName} failed:`, error?.message || error);
    })
    .finally(() => {
      loginAttempts.delete(providerName);
    });

  loginAttempts.set(providerName, attempt);
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!checkAuth(req)) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);

  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  if (url.pathname === '/' || url.pathname === '/health') {
    return sendJson(res, 200, {
      ok: true,
      provider: url.searchParams.get('provider') || defaultProvider,
      endpoints: [
        '/search?q=',
        '/add?id=&qty=',
        '/remove?id=',
        '/update?id=&qty=',
        '/basket',
        '/favourites',
        '/fav-search?q='
      ],
    });
  }

  const provider = getProvider(url);

  if (url.pathname === '/search') {
    const q = requireQuery(url, 'q');
    const limit = parsePositiveInt(url.searchParams.get('limit'), 'limit', 24);
    const products = await provider.search(q, { limit });
    return sendJson(res, 200, { products });
  }

  if (url.pathname === '/add') {
    const id = url.searchParams.get('id') || url.searchParams.get('q');
    if (!id) throw Object.assign(new Error('Missing query parameter: id'), { statusCode: 400 });
    const qty = parsePositiveInt(url.searchParams.get('qty'), 'qty', 1);
    await provider.addToBasket(id, qty);
    return sendJson(res, 200, { ok: true, provider: provider.name, product_id: id, quantity: qty });
  }

  if (url.pathname === '/remove') {
    const id = url.searchParams.get('id') || url.searchParams.get('q');
    if (!id) throw Object.assign(new Error('Missing query parameter: id'), { statusCode: 400 });
    await provider.removeFromBasket(id);
    return sendJson(res, 200, { ok: true, provider: provider.name, item_id: id });
  }

  if (url.pathname === '/update') {
    const id = url.searchParams.get('id') || url.searchParams.get('q');
    if (!id) throw Object.assign(new Error('Missing query parameter: id'), { statusCode: 400 });
    const qty = parsePositiveInt(url.searchParams.get('qty'), 'qty', 1);
    await provider.updateBasketItem(id, qty);
    return sendJson(res, 200, { ok: true, provider: provider.name, item_id: id, quantity: qty });
  }

  if (url.pathname === '/basket') {
    return sendJson(res, 200, await provider.getBasket());
  }

  if (url.pathname === '/favourites' || url.pathname === '/favorites') {
    const favouritesProvider = provider as FavouritesProvider;
    if (typeof favouritesProvider.getFavourites !== 'function') {
      return sendJson(res, 501, { error: `Provider "${provider.name}" does not support favourites` });
    }
    const limit = parsePositiveInt(url.searchParams.get('limit'), 'limit', 50);
    const products = await favouritesProvider.getFavourites({ limit });
    return sendJson(res, 200, { products });
  }

  if (url.pathname === '/fav-search' || url.pathname === '/favorite-search') {
    const favouritesProvider = provider as FavouritesProvider;
    if (typeof favouritesProvider.searchFavourites !== 'function') {
      return sendJson(res, 501, { error: `Provider "${provider.name}" does not support favourite search` });
    }
    const q = requireQuery(url, 'q');
    const limit = parsePositiveInt(url.searchParams.get('limit'), 'limit', 24);
    const products = await favouritesProvider.searchFavourites(q, { limit });
    return sendJson(res, 200, { products });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error: any) => {
    if (isProviderAuthError(error)) {
      const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);
      const providerName = (url.searchParams.get('provider') || defaultProvider) as ProviderName;
      sendJson(res, 401, { error: 'no session or session expired, attempting a login, try again in 30 seconds' });
      kickOffLogin(providerName);
      return;
    }

    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    sendJson(res, status, { error: error?.message || 'Internal server error' });
  });
});

server.listen(port, host, () => {
  console.log(`groc API listening on http://${host}:${port}`);
  console.log(`Provider: ${defaultProvider}`);
  if (!apiToken) {
    console.log('No GROC_API_TOKEN set; relying on localhost binding for access control.');
  }
  if (host !== '127.0.0.1' && host !== 'localhost' && !apiToken) {
    console.warn('WARNING: API is not bound to localhost and has no token. Set GROC_API_TOKEN.');
  }
});
