# Titanforge example app

A small fixture app demonstrating every route-discovery shape the compiler understands, and one
streaming/suspense component. It doubles as an integration-test fixture (see
`packages/webstack/webstack-cli/src/__tests__/build.test.ts`) and as living documentation.

## Route tree

```
routes/
  _layout.tsx           root layout, wraps every route
  index.tsx              /                    static
  users/
    _layout.tsx          nested layout, wraps every /users/* route
    index.tsx             /users               static, has a loader
    [id].tsx               /users/[id]          dynamic param, has a loader, streams a
                                                 suspense-boundary "comments" subtree
  blog/
    [...slug].tsx          /blog/[...slug]      catch-all param
```

## Running it

From the repo root, using a TypeScript-capable runner (e.g. `tsx`, not installed by default in
this repo — install it yourself, or run the compiler/runtime/dev-server packages' own test
suites, which exercise this app without needing a runner):

```sh
npx tsx packages/webstack/webstack-cli/src/cli.ts build
npx tsx packages/webstack/webstack-cli/src/cli.ts dev
```

`build` discovers every route under `routes/`, runs any registered plugins, and writes a typed
router module to `example/.generated/router.ts`. `dev` starts the HMR WebSocket channel and the
file-watch → esbuild-transform → broadcast pipeline over this same `routes/` directory (it does
not start an HTTP server — see the scope note on `dev()` in
`packages/webstack/webstack-cli/src/dev.ts`).
