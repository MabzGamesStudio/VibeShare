// One route shape for every server in the project.
//
// The three servers used to declare their routes three different ways: nodes called
// `router.get(path, handler)` one route at a time, the client daemon mixed `r.get(...)`
// with a hand-written table, and the client API kept its own `ApiRoute[]`. Everything
// now speaks the same `RouteEntry` / `RouteTable` pair: a route is data (method, path,
// handler), a table groups them, and `registerRouteTable()` is the only thing that binds
// a table to a Router. Because routes are data, `routeManifest()` can list them for
// docs and tests (docs/PROTOCOL.md is asserted against it) without parsing source.
import type { Router } from './http.js';

export type RouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** What a route's handler looks like, for any server's request type. */
export type RouteHandler<Request = unknown> = (request: Request) => unknown | Promise<unknown>;

/** One route as data. `handler` is the same function the Router would have taken. */
export interface RouteEntry<Request = unknown> {
  method: RouteMethod;
  path: string;
  handler: RouteHandler<Request>;
}

/** A named group of routes registered together: one server, or one area of a server. */
export interface RouteTable<Request = unknown> {
  /** Where the routes live: 'client daemon', 'provider admin', 'algorithm peers', … */
  name: string;
  /** A prefix every entry's path is joined to ('' for none). */
  base: string;
  routes: RouteEntry<Request>[];
}

/** A table from a name and its routes; `base` prefixes every path (e.g. '/v1/admin'). */
export function routeTable<Request = unknown>(name: string, routes: RouteEntry<Request>[], base = ''): RouteTable<Request> {
  return { name, base, routes };
}

/** Binds one table to a server's Router. The only way a table becomes live routes. */
export function registerRouteTable<Request>(router: Router, table: RouteTable<Request>): void {
  for (const route of table.routes) router.on(route.method, table.base + route.path, route.handler as never);
}

/** `{ method, path }` for one table, with the base applied. */
export function tableManifest(table: RouteTable<never> | RouteTable<unknown>): { method: RouteMethod; path: string }[] {
  return table.routes.map((route) => ({ method: route.method, path: `${table.base}${route.path}` }));
}

/** `{ method, path }` for many tables, in the order given. */
export function routeManifest(tables: (RouteTable<never> | RouteTable<unknown>)[]): { method: RouteMethod; path: string }[] {
  return tables.flatMap(tableManifest);
}
