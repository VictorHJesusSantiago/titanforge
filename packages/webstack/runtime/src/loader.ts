import type { Renderable } from './tree.js';

/** A route's data loader: takes URL params, returns (or resolves to) the route's data. */
export type Loader<TParams, TData> = (params: TParams) => TData | Promise<TData>;

/** A route's page component: a plain function from loaded data to a `Renderable` tree. */
export type PageComponent<TData> = (data: TData) => Renderable | Promise<Renderable>;

/**
 * Runs a route's loader to completion, then renders its page component with the loader's
 * resolved data as the component's only argument — the "data loaders run server-side
 * before/during render, and the resolved data is passed into the component as a prop" wiring
 * the brief asks for. This is intentionally the entire contract: no request/response object,
 * no context — a loader is a function of params, a component is a function of that loader's data.
 */
export async function renderRouteWithLoader<TParams, TData>(
  loader: Loader<TParams, TData>,
  params: TParams,
  component: PageComponent<TData>,
): Promise<Renderable> {
  const data = await loader(params);
  return component(data);
}
